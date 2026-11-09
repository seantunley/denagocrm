/**
 * A NEW ROW GETS ITS WORKSPACE WHETHER OR NOT ENFORCEMENT IS ON (2026-11-09).
 *
 * The scoped client stamped tenantId only while enforcing, so with enforcement off — the default, and the
 * rollback mode — every create that left it to the guard was written with tenantId NULL (a scan found 55: stock
 * timeline events, goods receipts, consent records, job-card entries…). And the audit trail resolved a
 * staff-attributed entry's workspace from the staff cookie alone, so everything DAX did over WhatsApp (no cookie)
 * was audited with no workspace — 83 rows in 30 days on production.
 *
 * Two real workspaces. In both modes, work running in A's scope:
 *   - a stock timeline event (one of the 55, written with no tenantId) lands in A;
 *   - a create that NAMES a workspace keeps it — the not-enforcing stamp only fills, never overrides;
 *   - a staff-attributed audit entry with NO session (the WhatsApp case) lands in A.
 * And with no scope at all, nothing is guessed: the row stays without a workspace rather than going to the
 * founding one.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes what it creates.
 */
import { basePrisma, prisma } from "../src/lib/db";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { runInTenantScope } from "../src/lib/tenantScope";
import { addStockEvent } from "../src/lib/stockPlatform";
import { logAudit } from "../src/lib/audit";
import { seedTwoTenants, teardown } from "./harness/seed";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`sm${SFX}`);
  const { a, b } = fixture;
  const inA = <T>(work: () => Promise<T>) => runInTenantScope({ tenantId: a.tenantId, system: false }, work);
  const actor = { id: a.memberUserId, name: `Harness A member` };
  try {
    for (const enforcing of [false, true]) {
      __setTenantEnforcingForTests(enforcing);
      const mode = enforcing ? "enforcement on" : "enforcement off";

      const eventType = `stamp.check.${enforcing ? "on" : "off"}.${SFX}`;
      await inA(() => addStockEvent({ eventType, actor }));
      const event = await basePrisma.stockEvent.findFirst({ where: { eventType }, select: { tenantId: true } });
      check(`${mode}: a stock timeline event written without a tenantId lands in its workspace`, event?.tenantId === a.tenantId, JSON.stringify(event));

      const action = `stamp.audit.${enforcing ? "on" : "off"}.${SFX}`;
      await inA(() => logAudit({ action, summary: "Harness: DAX confirmed over WhatsApp", user: { id: a.memberUserId, name: actor.name } }));
      const audit = await basePrisma.auditEvent.findFirst({ where: { eventType: action }, select: { tenantId: true } });
      check(`${mode}: a staff-attributed audit entry with no session lands in the workspace the work ran in`, audit?.tenantId === a.tenantId, JSON.stringify(audit));
    }

    __setTenantEnforcingForTests(false);
    // Only fills: a tenantId the caller names is kept. (Enforcement off; under enforcement the guard overrides.)
    const named = `stamp.named.${SFX}`;
    await inA(() => prisma.stockEvent.create({ data: { tenantId: b.tenantId, eventType: named, performedById: b.memberUserId, performedByName: "Harness B member" } }));
    const namedRow = await basePrisma.stockEvent.findFirst({ where: { eventType: named }, select: { tenantId: true } });
    check("enforcement off: a create that names its workspace keeps it", namedRow?.tenantId === b.tenantId, JSON.stringify(namedRow));

    // No scope: nothing to give, and nothing guessed.
    const unscoped = `stamp.unscoped.${SFX}`;
    await prisma.stockEvent.create({ data: { eventType: unscoped, performedById: a.memberUserId, performedByName: actor.name } });
    const unscopedRow = await basePrisma.stockEvent.findFirst({ where: { eventType: unscoped }, select: { tenantId: true } });
    check("enforcement off, no scope: no workspace is guessed", unscopedRow?.tenantId === null, JSON.stringify(unscopedRow));
  } finally {
    __setTenantEnforcingForTests(null);
    await basePrisma.stockEvent.deleteMany({ where: { eventType: { contains: SFX } } });
    await teardown(fixture);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => basePrisma.$disconnect());
