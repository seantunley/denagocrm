/**
 * REAL-DATABASE proof of learning from outcomes (lib/outcomeLearning; Sean, 2026-11-14: "DAX notices which
 * follow-ups, messages and timings led to won deals, and proposes updates to the team playbook for the owner to
 * approve").
 *
 *   npm run test:assistant-outcome-learning     (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * On the SCOPED client with enforcement on:
 *  - workspace A: 12 won deals all phoned, 12 lost none → a playbook "phone the customer" with 100% vs 0%, 12 and 12;
 *  - workspace B has the OPPOSITE pattern and more deals — none of it enters A's numbers, and B gets nothing filed;
 *  - the proposal is unreviewed and written by nobody, so a member's DAX doesn't load it — until the owner approves;
 *  - switched off: nothing runs; not due (checked this week): nothing runs; no customer name in the playbook.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 */
import { basePrisma } from "../src/lib/db";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { OUTCOME_LEARNING_KEY, OUTCOME_LEARNING_LAST_KEY, OUTCOME_LEARNING_SUMMARY_KEY, runOutcomeLearning } from "../src/lib/outcomeLearning";
import { loadLearned } from "../src/lib/assistantMemoryStore";
import { putWorkspaceSetting } from "../src/lib/settings";
import { seedTwoTenants, teardown } from "./harness/seed";

const SFX = Math.random().toString(16).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

function guardEnvironment() {
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = (process.env.DATABASE_URL ?? "").split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const KEYS = [OUTCOME_LEARNING_KEY, OUTCOME_LEARNING_LAST_KEY, OUTCOME_LEARNING_SUMMARY_KEY];

async function main() {
  guardEnvironment();
  const fixture = await seedTwoTenants(`olr${SFX}`);
  const { a, b } = fixture;
  const tenants = [a, b];
  const saved = await basePrisma.tenant.findMany({ where: { id: { in: [a.tenantId, b.tenantId] } }, select: { id: true, modules: true } });

  try {
    for (const t of saved) {
      await basePrisma.tenant.update({ where: { id: t.id }, data: { modules: [...new Set([...t.modules.split(","), "automation"])].filter(Boolean).join(",") } });
    }
    // A deal closed 30 days ago, made 60 days ago; phoned or not.
    const deal = async (t: (typeof tenants)[number], i: number, won: boolean, phoned: boolean) => {
      const lead = await basePrisma.lead.create({
        data: {
          tenantId: t.tenantId, stageId: t.rows.stageId, status: won ? "won" : "lost", name: `Outcome ${i} ${SFX}`, title: "Rover XL",
          valueCents: 1_000_000, createdById: t.ownerUserId, createdAt: ago(60), ...(won ? { wonAt: ago(30) } : { lostAt: ago(30), lostReason: "Price" }),
        },
        select: { id: true },
      });
      if (phoned) {
        await basePrisma.communication.create({ data: { tenantId: t.tenantId, type: "call", direction: "outbound", body: `Called ${SFX}`, leadId: lead.id, userId: t.ownerUserId, occurredAt: ago(50) } });
      }
    };
    // A: won deals were phoned, lost ones weren't.
    for (let i = 0; i < 12; i++) await deal(a, i, true, true);
    for (let i = 0; i < 12; i++) await deal(a, 100 + i, false, false);
    // B: the opposite, and more of them — if any leaked into A, A's numbers would move.
    for (let i = 0; i < 20; i++) await deal(b, i, true, false);
    for (let i = 0; i < 20; i++) await deal(b, 100 + i, false, true);

    const inA = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: a.tenantId, system: false }, async () => await fn());
    const inB = <T>(fn: () => Promise<T>) => runInTenantScope({ tenantId: b.tenantId, system: false }, async () => await fn());
    const playbooks = (tenantId: string) => basePrisma.assistantNote.findMany({ where: { tenantId, kind: "playbook", source: "outcomes" } });

    __setTenantEnforcingForTests(true);

    console.log("\nA works out its own habits");
    const summary = await inA(() => runOutcomeLearning(a.tenantId, { force: true }));
    const filed = await playbooks(a.tenantId);
    check("one playbook suggested", filed.length === 1, `${filed.length} — ${summary}`);
    const text = filed[0]?.content ?? "";
    check("phone calls: won 100% against lost 0%, from 12 won and 12 lost deals — A's numbers alone", /Phone the customer at least once\. Won deals did in 100% of cases, lost deals in 0% \(12 won and 12 lost deals\)/.test(text), text);
    check("unreviewed and written by nobody", filed[0]?.status === "unreviewed" && filed[0]?.createdById === null, JSON.stringify({ status: filed[0]?.status, by: filed[0]?.createdById }));
    check("no customer name in it", !text.includes(SFX) && !text.includes("Outcome"));

    console.log("\nNobody's DAX uses it until the owner approves");
    const before = await inA(() => loadLearned(a.memberUserId));
    check("a member's DAX doesn't load it", !before.playbooks.some((p) => p.id === filed[0]?.id));
    await basePrisma.assistantNote.update({ where: { id: filed[0]!.id }, data: { status: "approved", reviewedById: a.ownerUserId, reviewedAt: new Date() } });
    const after = await inA(() => loadLearned(a.memberUserId));
    check("approved: now it does", after.playbooks.some((p) => p.id === filed[0]?.id));

    console.log("\nThe other workspace, the switch and the week");
    check("B has nothing filed by A's run", (await playbooks(b.tenantId)).length === 0);
    check("A's run, again this week without Check now: not due", (await inA(() => runOutcomeLearning(a.tenantId))) === null);
    await putWorkspaceSetting(b.tenantId, OUTCOME_LEARNING_KEY, "off");
    check("B switched off: nothing runs", (await inB(() => runOutcomeLearning(b.tenantId, { force: true }))) === null && (await playbooks(b.tenantId)).length === 0);
  } finally {
    __setTenantEnforcingForTests(null);
    for (const t of tenants) {
      await basePrisma.assistantNote.deleteMany({ where: { tenantId: t.tenantId, source: "outcomes" } }).catch(() => 0);
      await basePrisma.appSetting.deleteMany({ where: { tenantId: t.tenantId, key: { in: KEYS } } }).catch(() => 0);
      await basePrisma.communication.deleteMany({ where: { tenantId: t.tenantId, body: `Called ${SFX}` } }).catch(() => 0);
      await basePrisma.lead.deleteMany({ where: { tenantId: t.tenantId, name: { endsWith: ` ${SFX}` } } }).catch(() => 0);
    }
    for (const t of saved) await basePrisma.tenant.update({ where: { id: t.id }, data: { modules: t.modules } }).catch(() => 0);
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
