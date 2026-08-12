import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

    // ── Create the restricted role + grants ────────────────────────────────────
    //
    // By running THE SHIPPED SCRIPT — prisma/rls/app-role.sql, the same file the
    // production cutover runs — rather than an inline copy of what it is believed
    // to do. An inline copy is a second definition of the role, and the two would
    // drift in the direction that makes the test pass: the test grants what the
    // test needs, production needs something the test never exercised.
    //
    // Concretely, that already-real gap is ALTER DEFAULT PRIVILEGES. The inline
    // grants covered the tables that existed; nothing covered the tables the NEXT
    // migration creates, so the first deploy after the cutover would have hit
    // "permission denied for table X" on a code path no test could have caught.
    // Running the real file means CI executes that line on every pass.
    await basePrisma.$executeRawUnsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY "${ROLE}"';
        EXECUTE 'DROP ROLE "${ROLE}"';
      END IF;
    END $$;`);

    // The role name is substituted so parallel runs cannot collide on one name;
    // everything else about the script is executed verbatim.
    const scriptPath = path.join(process.cwd(), "prisma", "rls", "app-role.sql");
    const source = fs.readFileSync(scriptPath, "utf8");
    if (!source.includes("crm_app")) {
      throw new Error(`${scriptPath} no longer mentions crm_app — the substitution below is stale`);
    }

    // Executed by THIS process, through the migration runner's own splitter,
    // rather than by spawning `npx prisma db execute`.
    //
    // Same SQL, same order, one fewer moving part — and it makes the suite
    // runnable on Windows, where `npx` cannot be started with execFileSync (no
    // PATHEXT handling without a shell). scripts/harness/testDatabase.ts
    // documents that same limitation for the migration runner and works around
    // it the same way. Before this, a developer on Windows could not run the one
    // suite that proves the role their whole cutover depends on.
    //
    // The splitter is doing real work: app-role.sql is mostly `DO $$ … $$`
    // blocks, and $executeRawUnsafe carries exactly one statement per round trip,
    // so a naive split on ";" would cut the PL/pgSQL bodies in half.
    const { splitSqlStatements } = (await import(
      new URL("./lib/splitSqlStatements.mjs", import.meta.url).href
    )) as { splitSqlStatements: (sql: string) => string[] };
    for (const statement of splitSqlStatements(source.replaceAll("crm_app", ROLE))) {
      await basePrisma.$executeRawUnsafe(statement);
    }

    // The script deliberately creates the role with a password nobody knows, so
    // that a credential never lands in the repository. Setting a known one is
    // step 2 of the cutover runbook, and it is step 2 here for the same reason.
    await basePrisma.$executeRawUnsafe(`ALTER ROLE "${ROLE}" PASSWORD '${ROLE_PW}'`);

    // The claim the whole suite rests on: this role cannot step over a policy.
    const [attrs] = await basePrisma.$queryRawUnsafe<{ rolsuper: boolean; rolbypassrls: boolean }[]>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = '${ROLE}'`,
    );
    check("shipped app-role.sql produces a NOSUPERUSER NOBYPASSRLS role", attrs?.rolsuper === false && attrs?.rolbypassrls === false);

    // And the line that only production would have discovered was missing: a
    // table created AFTER the grants must still be reachable.
    await basePrisma.$executeRawUnsafe(`CREATE TABLE "_future_${SFX}" ("id" text PRIMARY KEY)`);
    const [futureGrant] = await basePrisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT has_table_privilege('${ROLE}', '"_future_${SFX}"', 'SELECT') AS ok`,
    );
    check("a table created after the grants is still readable (ALTER DEFAULT PRIVILEGES)", futureGrant?.ok === true);
    await basePrisma.$executeRawUnsafe(`DROP TABLE "_future_${SFX}"`);

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

    // (10) THE SCOPED client's STANDALONE RAW path — the mirror of (8), and the one
    //      that did not exist. A Prisma query extension intercepts MODEL operations
    //      only, so `prisma.$queryRaw` skipped both the tenant scoping and the SET
    //      LOCAL. Fourteen user-facing raw reads went out with no GUC at all and
    //      worked purely because the app role still carried rolbypassrls; under THIS
    //      role they returned zero rows (assertion 1 is exactly that).
    //
    //      Scoped to A, so seeing ONLY A's row proves two things at once: the GUC is
    //      being set (or it would be zero), and it is being set to the caller's
    //      tenant rather than to bypass (or it would be two).
    const scopedRawA = await runInTenantScope({ tenantId: tA, system: false }, async () =>
      scoped.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
      ),
    );
    check(
      "scoped client RAW call, tenant A → only A (raw-method GUC patch)",
      scopedRawA.length === 1 && scopedRawA[0].id === cA,
    );

    // (11) The same raw path under tenant B. Together with (10) this is the
    //      isolation claim itself: the two tenants' raw reads cannot see each other.
    const scopedRawB = await runInTenantScope({ tenantId: tB, system: false }, async () =>
      scoped.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
      ),
    );
    check(
      "scoped client RAW call, tenant B → only B (raw reads are isolated)",
      scopedRawB.length === 1 && scopedRawB[0].id === cB,
    );

    // (12) And in off/monitor mode the same raw call must still return everything —
    //      the bypass branch — because that is what production runs today and this
    //      change must not alter it.
    __setTenantEnforcingForTests(false);
    const scopedRawOff = await scoped.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Contact" WHERE "id" IN ('${cA}', '${cB}')`,
    );
    check("off-mode scoped RAW call → sees both (unchanged from today)", scopedRawOff.length === 2);
    __setTenantEnforcingForTests(true);

    console.log(`\nRLS restricted-role proof: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
  } finally {
    __setTenantEnforcingForTests(null);
    if (restrictedRaw) await restrictedRaw.$disconnect();
    await basePrisma.contact.deleteMany({ where: { id: { in: [cA, cB] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } });
    // DROP OWNED BY clears the role's grants (ACL entries) so DROP ROLE succeeds.
    // The default-privilege rules app-role.sql installs are revoked explicitly
    // first: they are entries in pg_default_acl rather than grants on an object,
    // and leaving one behind makes DROP ROLE fail with a dependency error that
    // would then mask the real result of the run.
    await basePrisma.$executeRawUnsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM "${ROLE}"';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM "${ROLE}"';
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
