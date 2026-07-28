import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  basePrisma,
  __buildScopedClientForTests,
  __buildBypassClientForTests,
} from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";

// RLS PROOF under a RESTRICTED database role.
//
// The other suites connect as the container's bootstrap account (POSTGRES_USER),
// which is a SUPERUSER — and superusers bypass Row Level Security ENTIRELY. So an
// "only sees its own tenant" assertion there is really proving the APP-LAYER guard,
// not RLS. This suite creates a NOSUPERUSER NOBYPASSRLS role (what production Neon
// actually uses), connects as it, and drives the REAL scoped client
// (__buildScopedClientForTests → the same buildClient/withRlsScope the exported
// `prisma` uses) so FORCE ROW LEVEL SECURITY is genuinely exercised.

const SFX = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const tA = `rlsA_${SFX}`;
const tB = `rlsB_${SFX}`;
const cA = `rlscA_${SFX}`;
const cB = `rlscB_${SFX}`;
const ROLE = `app_rls_test_${SFX}`;
const ROLE_PW = "app_rls_test_pw";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean) {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

/** Build the restricted-role connection string from DATABASE_URL (same host/db). */
function restrictedUrl(): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.username = ROLE;
  u.password = ROLE_PW;
  return u.toString();
}

async function main() {
  // HARD guard — creates a DB role + rows; throwaway *_test database only.
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
    throw new Error(
      `test-rls-restricted refuses to run: expected NODE_ENV=test and a *_test database, got NODE_ENV=${process.env.NODE_ENV} db=${dbName || "(none)"}.`,
    );
  }

  let restrictedRaw: PrismaClient | null = null;
  try {
    // ── Fixtures (as superuser, bypass): two tenants, one Contact each ─────────
    await basePrisma.tenant.createMany({
      data: [
        { id: tA, name: "RLS A", slug: tA, active: true },
        { id: tB, name: "RLS B", slug: tB, active: true },
      ],
    });
    await basePrisma.contact.createMany({
      data: [
        { id: cA, firstName: "A", tenantId: tA },
        { id: cB, firstName: "B", tenantId: tB },
      ],
    });

    // ── Create the restricted role + grants (idempotent) ───────────────────────
    await basePrisma.$executeRawUnsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY "${ROLE}"';
        EXECUTE 'DROP ROLE "${ROLE}"';
      END IF;
    END $$;`);
    await basePrisma.$executeRawUnsafe(
      `CREATE ROLE "${ROLE}" LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS`,
    );
    await basePrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
    await basePrisma.$executeRawUnsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`,
    );
    await basePrisma.$executeRawUnsafe(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`,
    );

    restrictedRaw = new PrismaClient({ datasources: { db: { url: restrictedUrl() } } });
    const scoped = __buildScopedClientForTests(restrictedRaw);
    const bypass = __buildBypassClientForTests(restrictedRaw);

    __setTenantEnforcingForTests(true);

    // (1) Direct access, no GUC, no bypass → RLS denies every row. This is the pure
    //     RLS proof: a raw query with no app-layer guard sees NOTHING.
    const directNoGuc = await restrictedRaw.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
    );
    check("restricted role, no GUC → 0 rows (RLS denies)", Number(directNoGuc[0]?.count ?? -1) === 0);

    // (2) Direct access WITH a tenant GUC set in a transaction → only that tenant's
    //     row, proving RLS filters by app.current_tenant at the DB, independent of
    //     any application code.
    const directWithGuc = await restrictedRaw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${tA}', TRUE)`);
      return tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
      );
    });
    check("restricted role, GUC=A → only A's row (RLS filters by current_tenant)", directWithGuc.length === 1 && directWithGuc[0].id === cA);

    // (3) Tenant A through the REAL scoped client (buildClient → withRlsScope).
    const aRows = await runInTenantScope({ tenantId: tA, system: false }, async () =>
      scoped.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } }),
    );
    check("scoped client, tenant A → sees only A", aRows.length === 1 && aRows[0].id === cA);

    // (4) Tenant B through the same real scoped client.
    const bRows = await runInTenantScope({ tenantId: tB, system: false }, async () =>
      scoped.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } }),
    );
    check("scoped client, tenant B → sees only B", bRows.length === 1 && bRows[0].id === cB);

    // (5) The bypass client (basePrisma equivalent) over the SAME restricted role
    //     sees BOTH — proving the rows are there and only RLS was hiding them.
    const bypassRows = await bypass.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } });
    check("bypass client over restricted role → sees BOTH tenants", bypassRows.length === 2);

    // (6) off/monitor mode still works under FORCE RLS (withRlsScope sets bypass).
    __setTenantEnforcingForTests(false);
    const offRows = await scoped.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } });
    check("off-mode scoped client → sees both under FORCE RLS (bypass path)", offRows.length === 2);
    __setTenantEnforcingForTests(true);

    // (7) Two concurrent tenant scopes NEVER share GUC state — each interactive
    //     transaction pins its own connection and SET LOCAL is transaction-local.
    const [concA, concB] = await Promise.all([
      runInTenantScope({ tenantId: tA, system: false }, async () =>
        scoped.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } }),
      ),
      runInTenantScope({ tenantId: tB, system: false }, async () =>
        scoped.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } }),
      ),
    ]);
    check(
      "concurrent tenant scopes never share GUC (A→A only, B→B only)",
      concA.length === 1 && concA[0].id === cA && concB.length === 1 && concB[0].id === cB,
    );

    // (8) The bypass client's STANDALONE RAW path (the patched $queryRawUnsafe) must
    //     also set bypass — under the restricted role a raw read with no GUC returns
    //     zero (assertion 1), so seeing BOTH proves the raw-method patch works. This
    //     is the SAME buildBypassClient the exported `basePrisma` is built from.
    const bypassRaw = await bypass.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
    );
    check("bypass client raw call over restricted role → sees BOTH (raw-method patch)", Number(bypassRaw[0]?.count ?? -1) === 2);

    // (9) The bypass client's INTERACTIVE TRANSACTION path — a model op inside
    //     bypass.$transaction(async tx => …) must see every tenant's rows, proving the
    //     $transaction wrapper sets bypass for the whole body on the pinned connection.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bypassTx = await (bypass as any).$transaction(async (tx: any) =>
      tx.contact.findMany({ where: { id: { in: [cA, cB] } }, select: { id: true } }),
    );
    check("bypass client interactive tx over restricted role → sees BOTH ($transaction wrapper)", bypassTx.length === 2);

    console.log(`\nRLS restricted-role proof: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
  } finally {
    __setTenantEnforcingForTests(null);
    if (restrictedRaw) await restrictedRaw.$disconnect();
    await basePrisma.contact.deleteMany({ where: { id: { in: [cA, cB] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } });
    // DROP OWNED BY clears the role's grants (ACL entries) so DROP ROLE succeeds.
    await basePrisma.$executeRawUnsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY "${ROLE}"';
        EXECUTE 'DROP ROLE "${ROLE}"';
      END IF;
    END $$;`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
