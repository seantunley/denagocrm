import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { basePrisma, __buildScopedClientForTests } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";

// TWO-TENANT END-TO-END CRM ISOLATION, under a RESTRICTED (NOSUPERUSER NOBYPASSRLS)
// role so FORCE ROW LEVEL SECURITY is genuinely exercised.
//
// The RLS proof (test-rls-restricted) checks the primitives on Contact. THIS suite
// drives ORDINARY CRM operations — create a contact, tag it, open a support case —
// as two different tenants through the REAL scoped client, and asserts that no
// tenant can read, change, or collide with another tenant's data. It is the
// regression guard for "green CI but cross-tenant leakage in a real flow".

const SFX = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const tA = `eeA_${SFX}`;
const tB = `eeB_${SFX}`;
const ROLE = `app_e2e_test_${SFX}`;
const ROLE_PW = "app_e2e_test_pw";

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

function restrictedUrl(): string {
  const u = new URL(process.env.DATABASE_URL as string);
  u.username = ROLE;
  u.password = ROLE_PW;
  return u.toString();
}

/** Run `fn` as tenant `t` through the real scoped client (enforcement on). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asTenant<T>(_scoped: any, t: string, fn: () => Promise<T>): Promise<T> {
  // MUST use `async () => fn()`, not `fn` directly. With a non-async fn, storage.run()
  // returns the PrismaPromise immediately and the outer `await` calls .then() outside the
  // storage context, so currentTenantScope() returns undefined inside the extension hook.
  // With an async wrapper, the async machinery calls prismaPromise.then() from within
  // the async function's execution context (which inherited the storage scope).
  return runInTenantScope({ tenantId: t, system: false }, async () => fn());
}

async function main() {
  const dbName = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (process.env.NODE_ENV !== "test" || !dbName.endsWith("_test")) {
    throw new Error(
      `test-tenant-e2e refuses to run: expected NODE_ENV=test and a *_test database, got NODE_ENV=${process.env.NODE_ENV} db=${dbName || "(none)"}.`,
    );
  }

  let restrictedRaw: PrismaClient | null = null;
  try {
    // ── Two tenants (as superuser, bypass) ─────────────────────────────────────
    await basePrisma.tenant.createMany({
      data: [
        { id: tA, name: "E2E A", slug: tA, active: true },
        { id: tB, name: "E2E B", slug: tB, active: true },
      ],
    });

    // ── Restricted role + grants ───────────────────────────────────────────────
    await basePrisma.$executeRawUnsafe(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE 'DROP OWNED BY "${ROLE}"';
        EXECUTE 'DROP ROLE "${ROLE}"';
      END IF;
    END $$;`);
    await basePrisma.$executeRawUnsafe(`CREATE ROLE "${ROLE}" LOGIN PASSWORD '${ROLE_PW}' NOSUPERUSER NOBYPASSRLS`);
    await basePrisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
    await basePrisma.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`);
    await basePrisma.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`);

    restrictedRaw = new PrismaClient({ datasources: { db: { url: restrictedUrl() } } });
    const scoped = __buildScopedClientForTests(restrictedRaw);
    __setTenantEnforcingForTests(true);

    // ── Ordinary CRM writes, each tenant acting in its own scope ────────────────
    const alice = await asTenant(scoped, tA, () =>
      scoped.contact.create({ data: { firstName: "Alice", company: "Acme A" }, select: { id: true, tenantId: true } }),
    );
    const bob = await asTenant(scoped, tB, () =>
      scoped.contact.create({ data: { firstName: "Bob", company: "Beta B" }, select: { id: true, tenantId: true } }),
    );
    check("create stamps the acting tenant (A)", alice.tenantId === tA);
    check("create stamps the acting tenant (B)", bob.tenantId === tB);

    // Same tag NAME in both tenants must NOT collide (per-tenant uniqueness).
    // Tag.tenantId is NOT NULL so the type requires it; the scoped guard re-stamps it
    // to the acting tenant anyway (asserted indirectly by the isolation checks below).
    let tagCollision = false;
    const vipA = await asTenant(scoped, tA, () => scoped.tag.create({ data: { name: "VIP", tenantId: tA }, select: { id: true } }));
    let vipB: { id: string } | null = null;
    try {
      vipB = await asTenant(scoped, tB, () => scoped.tag.create({ data: { name: "VIP", tenantId: tB }, select: { id: true } }));
    } catch {
      tagCollision = true;
    }
    check("same tag name in two tenants does NOT collide (per-tenant unique)", !tagCollision && !!vipB);

    // A support case for each tenant's contact.
    const caseA = await asTenant(scoped, tA, () =>
      scoped.customerCase.create({
        data: { subject: "A ticket", description: "hello from A", type: "support", status: "open", source: "staff", contactId: alice.id, lastReplyBy: "staff" },
        select: { id: true, tenantId: true },
      }),
    );
    await asTenant(scoped, tB, () =>
      scoped.customerCase.create({
        data: { subject: "B ticket", description: "hello from B", type: "support", status: "open", source: "staff", contactId: bob.id, lastReplyBy: "staff" },
        select: { id: true },
      }),
    );
    check("case create stamps the acting tenant (A)", caseA.tenantId === tA);

    // ── Isolation: reads ────────────────────────────────────────────────────────
    const aContacts = await asTenant(scoped, tA, () => scoped.contact.findMany({ where: { id: { in: [alice.id, bob.id] } }, select: { id: true } }));
    check("A lists contacts → only A's (Bob invisible)", aContacts.length === 1 && aContacts[0].id === alice.id);

    const bContacts = await asTenant(scoped, tB, () => scoped.contact.findMany({ where: { id: { in: [alice.id, bob.id] } }, select: { id: true } }));
    check("B lists contacts → only B's (Alice invisible)", bContacts.length === 1 && bContacts[0].id === bob.id);

    const aSeesBob = await asTenant(scoped, tA, () => scoped.contact.findUnique({ where: { id: bob.id }, select: { id: true } }));
    check("A findUnique(B's contact) → null", aSeesBob === null);

    const aCases = await asTenant(scoped, tA, () => scoped.customerCase.findMany({ where: { contactId: { in: [alice.id, bob.id] } }, select: { id: true } }));
    check("A lists cases → only A's ticket", aCases.length === 1 && aCases[0].id === caseA.id);

    const aTags = await asTenant(scoped, tA, () => scoped.tag.findMany({ where: { name: "VIP" }, select: { id: true } }));
    check("A lists 'VIP' tags → only A's row", aTags.length === 1 && aTags[0].id === vipA.id);

    // ── Isolation: cross-tenant MUTATION refused ───────────────────────────────
    let updateBlocked = false;
    try {
      await asTenant(scoped, tA, () => scoped.contact.update({ where: { id: bob.id }, data: { city: "Hijacked" } }));
    } catch {
      updateBlocked = true;
    }
    check("A update(B's contact) → refused (P2025, RLS/where scope)", updateBlocked);

    const bobDeletedByA = await asTenant(scoped, tA, () => scoped.customerCase.deleteMany({ where: { contactId: bob.id } }));
    check("A deleteMany(B's case) → 0 rows affected", bobDeletedByA.count === 0);

    // ── Confirm both tenants' rows really exist (only RLS was hiding them) ───────
    const allVip = await basePrisma.tag.findMany({ where: { tenantId: { in: [tA, tB] }, name: "VIP" }, select: { tenantId: true } });
    check("both tenants' 'VIP' tags persisted (bypass sees 2)", allVip.length === 2);

    const bobStillThere = await basePrisma.contact.findUnique({ where: { id: bob.id }, select: { city: true } });
    check("B's contact was never mutated by A", (bobStillThere?.city ?? null) === null);

    console.log(`\nTwo-tenant CRM e2e: ${passed} passed, ${failed} failed.`);
    if (failed > 0) process.exit(1);
  } finally {
    __setTenantEnforcingForTests(null);
    if (restrictedRaw) await restrictedRaw.$disconnect();
    // FK-safe teardown, all via bypass.
    await basePrisma.customerCase.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await basePrisma.contact.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await basePrisma.tag.deleteMany({ where: { tenantId: { in: [tA, tB] } } });
    await basePrisma.tenant.deleteMany({ where: { id: { in: [tA, tB] } } });
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
