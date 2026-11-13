/**
 * REAL-DATABASE proof of EDIT AND RE-ASK's withdrawal (src/lib/assistantEdit.ts — review of #1092).
 *
 * Only a database can show what taking a question back actually touches:
 *  - the person's LAST chat question is deleted, and the plan IT offered is closed;
 *  - an earlier answer's plan, made a moment before, stays open;
 *  - a card saved from WhatsApp in the same minute, and a colleague's plan, are never touched — nothing is matched
 *    by time;
 *  - an older question, someone else's, or another workspace's is refused ("not-latest") and changes nothing.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, removes every row it creates. No AI is called.
 */
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { withdrawLastQuestion } from "../src/lib/assistantEdit";

const SFX = Math.random().toString(36).slice(2, 10);
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
function guardEnvironment() {
  const url = process.env.DATABASE_URL ?? "";
  if (process.env.NODE_ENV !== "test") throw new Error("Refusing to run outside NODE_ENV=test");
  const name = url.split("/").pop()?.split("?")[0] ?? "";
  if (!/_test$/.test(name)) throw new Error(`Refusing to run against database "${name}" — the name must end in _test`);
}

const cid = () => `c${SFX}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 25).padEnd(25, "0");
const T = DEFAULT_TENANT_ID;
const T2 = `t_edit_${SFX}`;
const me = { id: `ed-me-${SFX}`, name: "Ed me", email: `ed-me-${SFX}@example.invalid` };
const colleague = { id: `ed-col-${SFX}`, name: "Ed colleague", email: `ed-col-${SFX}@example.invalid` };
const TURN = { earlier: cid(), last: cid(), colleagues: cid(), otherWs: cid() };
const PLAN = { earlier: cid(), last: cid(), colleagues: cid() };
const SAVED = cid();
const inT = <R>(fn: () => Promise<R>) => runInTenantScope({ tenantId: T, system: false }, fn);

async function seed() {
  await basePrisma.tenant.create({ data: { id: T2, name: `Edit ${SFX}`, slug: T2, active: true } });
  await basePrisma.user.createMany({ data: [me, colleague].map((u) => ({ ...u, passwordHash: "test", role: "member", modules: "crm" })) });
  const now = Date.now();
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
  const plan = (id: string, userId: string) => ({ id, tenantId: T, userId, kind: "plan", title: "Plan", status: "open", details: {}, steps: {}, updatedAt: new Date() });
  // Two plans of mine, offered a few seconds apart by two answers — and a colleague's, at the same moment.
  await basePrisma.assistantTask.createMany({ data: [plan(PLAN.earlier, me.id), plan(PLAN.last, me.id), plan(PLAN.colleagues, colleague.id)] });
  await basePrisma.assistantTurn.createMany({
    data: [
      { id: TURN.earlier, tenantId: T, userId: me.id, question: "first", answer: "a1", source: "chat", createdAt: at(20), proposed: [{ kind: "plan", planId: PLAN.earlier }] },
      { id: TURN.last, tenantId: T, userId: me.id, question: "second", answer: "a2", source: "chat", createdAt: at(10), proposed: [{ kind: "plan", planId: PLAN.last }, { kind: "note", leadId: "x" }] },
      { id: TURN.colleagues, tenantId: T, userId: colleague.id, question: "theirs", answer: "a3", source: "chat", createdAt: at(10), proposed: [{ kind: "plan", planId: PLAN.colleagues }] },
      { id: TURN.otherWs, tenantId: T2, userId: me.id, question: "elsewhere", answer: "a4", source: "chat", createdAt: at(5) },
    ],
  });
  // A card saved from WhatsApp for the Ask page, in the SAME seconds: the old time window would have expired it.
  await basePrisma.assistantPendingAction.create({ data: { id: SAVED, tenantId: T, userId: me.id, card: { kind: "note" }, forCrm: true, createdAt: at(10), expiresAt: new Date(now + 3_600_000) } });
}

async function cleanup() {
  await basePrisma.assistantPendingAction.deleteMany({ where: { id: SAVED } });
  await basePrisma.assistantTurn.deleteMany({ where: { id: { in: Object.values(TURN) } } });
  await basePrisma.assistantTask.deleteMany({ where: { id: { in: Object.values(PLAN) } } });
  await basePrisma.user.deleteMany({ where: { id: { in: [me.id, colleague.id] } } });
  await basePrisma.tenant.deleteMany({ where: { id: T2 } });
}

async function main() {
  guardEnvironment();
  await seed();
  __setTenantEnforcingForTests(true);
  const status = async (id: string) => (await basePrisma.assistantTask.findUnique({ where: { id }, select: { status: true } }))?.status;
  const exists = async (id: string) => Boolean(await basePrisma.assistantTurn.findUnique({ where: { id }, select: { id: true } }));

  console.log("\nRefused: not my latest question, or not mine");
  check("an older question of mine is refused", (await inT(() => withdrawLastQuestion(T, me.id, TURN.earlier))) === "not-latest");
  check("a colleague's question is refused", (await inT(() => withdrawLastQuestion(T, me.id, TURN.colleagues))) === "not-latest");
  check("another workspace's is refused", (await inT(() => withdrawLastQuestion(T, me.id, TURN.otherWs))) === "not-latest");
  check("…and nothing changed", (await exists(TURN.earlier)) && (await exists(TURN.last)) && (await status(PLAN.last)) === "open");

  console.log("\nWithdrawn: my last question");
  check("my last question is withdrawn", (await inT(() => withdrawLastQuestion(T, me.id, TURN.last))) === "withdrawn");
  check("…its exchange is gone", !(await exists(TURN.last)));
  check("…the plan IT offered is closed", (await status(PLAN.last)) === "closed");
  check("the earlier answer's plan, seconds older, is still open", (await status(PLAN.earlier)) === "open");
  check("a colleague's plan made at the same moment is untouched", (await status(PLAN.colleagues)) === "open");
  const saved = await basePrisma.assistantPendingAction.findUnique({ where: { id: SAVED }, select: { expiresAt: true } });
  check("a card saved from WhatsApp in the same seconds is NOT expired", Boolean(saved && saved.expiresAt.getTime() > Date.now()));
  check("the earlier exchange is still there, and the other workspace's", (await exists(TURN.earlier)) && (await exists(TURN.otherWs)));

  console.log(`\n${passed} passed, ${failed} failed`);
}

main()
  .catch((error) => {
    failed++;
    console.error(error);
  })
  .finally(async () => {
    __setTenantEnforcingForTests(false);
    await cleanup().catch((error) => console.error("cleanup failed", error));
    await basePrisma.$disconnect();
    process.exit(failed ? 1 : 0);
  });
