/**
 * DAX DELIVERY GOALS on a real database (roadmap Phase 4b, 2026-10-27).
 *
 *   npm run test:assistant-goals      (NODE_ENV=test, DATABASE_URL = a disposable, migrated *_test database)
 *
 * What a source test cannot show, through the SCOPED client with tenant enforcement on:
 *  - a goal set on the Ask page follows a delivery step by step to done — each step news once — and, in the
 *    same transaction as finishing, switches off its own watches and DAX check-backs and drops what it had not
 *    yet sent, leaving everybody else's reminders (and the person's own scheduled questions) alone;
 *  - a lost deal ends it the same way;
 *  - two cron passes at once: one does the work, the other nothing — never two alerts, never two finishes;
 *  - another person's or another workspace's goal is never reached; access lost stops it; the Automotive module
 *    off leaves every goal exactly as it was, and refuses new ones; goals are off until the person's proactive
 *    switch is on;
 *  - the customer is never contacted.
 * It also scores the eval scenario (evals/daxResearchQuality.ts GOAL_SCENARIOS) on what the database shows.
 *
 * SAFETY: refuses to run outside NODE_ENV=test on a *_test database, and removes every row it creates.
 * No model, WhatsApp, email or push is ever called (no phone links or push subscriptions exist for these people).
 */
import { mock } from "node:test";
import { basePrisma } from "../src/lib/db";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";
import { runInTenantScope } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import type { PermissionUser } from "../src/lib/permissions";
import { GOAL_BATCH, closeGoal, goalsForAskPage, pruneAssistantTasks, runDeliveryGoals, setGoalPaused, startDeliveryGoal } from "../src/lib/assistantGoals";
import { withSystemScope } from "../src/lib/tenantScopeEntry";
import { openTasks, tasksForAskPage } from "../src/lib/assistantTask";
import { ASSISTANT_PROACTIVE_KEY, proactivePersonKey } from "../src/lib/proactiveRules";
import { GOAL_SCENARIOS, scoreGoalScenario, formatReport } from "../evals/daxResearchQuality";

const SFX = Math.random().toString(16).slice(2, 10);
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

const id = (what: string) => `asst-goal-${what}-${SFX}`;
const T = DEFAULT_TENANT_ID;
const OTHER_TENANT = id("tenant");
const rep: PermissionUser = { id: id("rep"), name: "Rep", email: `${id("rep")}@example.invalid`, role: "member" };
const other: PermissionUser = { id: id("other"), name: "Other", email: `${id("other")}@example.invalid`, role: "member" };
const STAGE = id("stage");
const PRODUCT = id("product");
const C = { anna: id("c-anna"), ben: id("c-ben"), notHis: id("c-nothis"), others: id("c-others") };
const L = { anna: id("l-anna"), ben: id("l-ben") };
const Q = { anna: id("q-anna"), ben: id("q-ben"), draft: id("q-draft"), lapsed: id("q-lapsed"), others: id("q-others"), modular: id("q-mod"), quiet: id("q-quiet"), aged: id("q-aged") };
const NO = 900_000_000 + Math.floor(Math.random() * 90_000_000);
const NUM = { anna: NO, ben: NO + 1, draft: NO + 2, lapsed: NO + 3, others: NO + 4, modular: NO + 5, quiet: NO + 6, aged: NO + 7 };
const UNIT = { anna: id("u-anna"), modular: id("u-mod") };
const scoped = <R>(fn: () => Promise<R>, tenantId = T) => runInTenantScope({ tenantId, system: false }, fn);
const budget = { shouldStop: () => false };
const tick = (tenantId = T) => scoped(() => runDeliveryGoals(tenantId, budget), tenantId);
const settingKeys = [ASSISTANT_PROACTIVE_KEY, proactivePersonKey(rep.id), proactivePersonKey(other.id)];
let savedSettings: { key: string; value: string }[] = [];
let savedModules: string | null = null;
let granted = "";

async function setSetting(key: string, value: string) {
  await basePrisma.appSetting.upsert({ where: { tenantId_key: { tenantId: T, key } }, create: { tenantId: T, key, value }, update: { value } });
}

async function seed() {
  savedSettings = await basePrisma.appSetting.findMany({ where: { tenantId: T, key: { in: settingKeys } }, select: { key: true, value: true } });
  savedModules = (await basePrisma.tenant.findUnique({ where: { id: T }, select: { modules: true } }))?.modules ?? null;
  // The assistant and Automotive granted for the run, whatever this database had (restored in cleanup).
  granted = [...new Set([...(savedModules ?? "").split(","), "automation", "automotive"])].filter(Boolean).join(",");
  await basePrisma.tenant.update({ where: { id: T }, data: { modules: granted } });
  await basePrisma.tenant.create({ data: { id: OTHER_TENANT, name: `Goal test ${SFX}`, slug: `goal-test-${SFX}`, modules: "automation,automotive" } });
  await basePrisma.user.createMany({ data: [rep, other].map((u) => ({ id: u.id, name: u.name, email: u.email, passwordHash: "test", role: "member", modules: "crm" })) });
  await basePrisma.$executeRaw`
    INSERT INTO "UserRole" ("id", "userId", "roleId", "tenantId") VALUES
      (gen_random_uuid()::text, ${rep.id}, 'role_sales_rep', ${T}),
      (gen_random_uuid()::text, ${other.id}, 'role_sales_rep', ${T})`;
  await basePrisma.$executeRaw`INSERT INTO "TenantMember" ("id", "tenantId", "userId") VALUES (${id("tm-rep")}, ${T}, ${rep.id}), (${id("tm-other")}, ${T}, ${other.id})`;
  await basePrisma.$executeRaw`
    INSERT INTO "PipelineStage" ("id", "tenantId", "name", "order", "color", "pipelineId", "defaultProbability", "isClosed")
    VALUES (${STAGE}, ${T}, ${`Goals ${SFX}`}, 900003, '#64748b', 'pipeline_default_retail', 10, false)`;
  await basePrisma.contact.createMany({
    data: [
      { id: C.anna, tenantId: T, firstName: "Anna", lastName: `Goal${SFX}`, ownerId: rep.id, createdById: rep.id },
      { id: C.ben, tenantId: T, firstName: "Ben", lastName: `Goal${SFX}`, ownerId: rep.id, createdById: rep.id },
      // Somebody else's customer: rep's quote for them is his only while he made it.
      { id: C.notHis, tenantId: T, firstName: "Cara", lastName: `Goal${SFX}`, ownerId: other.id, createdById: other.id },
      { id: C.others, tenantId: T, firstName: "Dan", lastName: `Goal${SFX}`, ownerId: other.id, createdById: other.id },
    ],
  });
  await basePrisma.lead.createMany({
    data: [
      { id: L.anna, tenantId: T, title: "Rover XL", name: `Anna Goal${SFX}`, stageId: STAGE, contactId: C.anna, assignedToId: rep.id, createdById: rep.id },
      { id: L.ben, tenantId: T, title: "Nomad", name: `Ben Goal${SFX}`, stageId: STAGE, contactId: C.ben, assignedToId: rep.id, createdById: rep.id },
    ],
  });
  await basePrisma.product.create({ data: { id: PRODUCT, tenantId: T, name: `Goal Rover ${SFX}`, basePriceCents: 23_500_000 } });
  const quote = (qid: string, number: number, contactId: string, createdById: string, extra: Record<string, unknown> = {}) =>
    basePrisma.quote.create({ data: { id: qid, number, tenantId: T, contactId, createdById, status: "accepted", ...extra }, select: { id: true } });
  await quote(Q.anna, NUM.anna, C.anna, rep.id, { leadId: L.anna });
  await quote(Q.ben, NUM.ben, C.ben, rep.id, { leadId: L.ben });
  await quote(Q.draft, NUM.draft, C.anna, rep.id, { status: "draft" });
  await quote(Q.lapsed, NUM.lapsed, C.notHis, rep.id);
  await quote(Q.others, NUM.others, C.others, other.id);
  await quote(Q.modular, NUM.modular, C.anna, rep.id);
  await quote(Q.quiet, NUM.quiet, C.anna, rep.id);
  await quote(Q.aged, NUM.aged, C.anna, rep.id);
  // Both switches on for both people — proactive DAX's, which goals ride (default OFF).
  for (const key of settingKeys) await setSetting(key, "on");
}

async function cleanup() {
  const users = [rep.id, other.id];
  await basePrisma.assistantProactiveAlert.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.assistantTurn.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.assistantTask.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.assistantWatch.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.assistantSchedule.deleteMany({ where: { userId: { in: users } } });
  await basePrisma.stockUnit.deleteMany({ where: { id: { in: Object.values(UNIT) } } });
  await basePrisma.quote.deleteMany({ where: { id: { in: Object.values(Q) } } });
  await basePrisma.lead.deleteMany({ where: { id: { in: Object.values(L) } } });
  await basePrisma.auditLog.deleteMany({ where: { OR: [{ contactId: { in: Object.values(C) } }, { userId: { in: users } }] } });
  await basePrisma.contact.deleteMany({ where: { id: { in: Object.values(C) } } });
  await basePrisma.product.deleteMany({ where: { id: PRODUCT } });
  await basePrisma.$executeRaw`DELETE FROM "PipelineStage" WHERE "id" = ${STAGE}`;
  await basePrisma.$executeRaw`DELETE FROM "TenantMember" WHERE "userId" IN (${rep.id}, ${other.id})`;
  await basePrisma.$executeRaw`DELETE FROM "UserRole" WHERE "userId" IN (${rep.id}, ${other.id})`;
  await basePrisma.user.deleteMany({ where: { id: { in: users } } });
  await basePrisma.tenant.deleteMany({ where: { id: OTHER_TENANT } });
  await basePrisma.appSetting.deleteMany({ where: { tenantId: T, key: { in: settingKeys } } });
  for (const s of savedSettings) await setSetting(s.key, s.value);
  if (savedModules !== null) await basePrisma.tenant.update({ where: { id: T }, data: { modules: savedModules } });
}

/**
 * Run `fn` with the clock (Date only — no timers) at this hour in Johannesburg today, so quiet hours are tested
 * the same at any time of day. Everything else in the run is real time.
 */
async function atSaHour<R>(hour: number, fn: () => Promise<R>): Promise<R> {
  const sa = new Date(Date.now() + 2 * 3_600_000);
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(sa.getUTCFullYear(), sa.getUTCMonth(), sa.getUTCDate(), hour - 2, 0, 0) });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

const goal = (gid: string) => basePrisma.assistantTask.findUnique({ where: { id: gid } });
/** The next cron pass may check it again (as half an hour later would). */
async function unfresh(gid: string, patch: Record<string, unknown> = {}) {
  const row = await goal(gid);
  const { checkedAt: _checked, ...details } = (row?.details ?? {}) as Record<string, unknown>;
  void _checked;
  await basePrisma.assistantTask.update({ where: { id: gid }, data: { details: { ...details, ...patch } as object } });
}
const alertsOf = async (gid: string) =>
  (await basePrisma.assistantProactiveAlert.findMany({ where: { recordKey: { startsWith: `${gid}:` } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }))
    .map((a) => ({ ...a, key: a.recordKey.slice(gid.length + 1) }));
const customerMessages = () => basePrisma.communication.count({ where: { OR: [{ contactId: { in: Object.values(C) } }, { leadId: { in: Object.values(L) } }] } });
const quoteUpdate = (qid: string, data: Record<string, unknown>) => basePrisma.quote.update({ where: { id: qid }, data });

async function main() {
  guardEnvironment();
  __setTenantEnforcingForTests(true);
  await seed();

  console.log("\nSetting a goal");
  let annaGoal = "";
  {
    await setSetting(proactivePersonKey(rep.id), "off");
    const off = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.anna}`));
    check("off until the person switches proactive DAX on for themselves", !off.ok && /switch proactive DAX on/.test(off.error), JSON.stringify(off));
    await setSetting(proactivePersonKey(rep.id), "on");
    const draft = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.draft}`));
    check("a quote not accepted yet is refused", !draft.ok && /isn't accepted yet/.test(draft.error), JSON.stringify(draft));
    const notHis = await scoped(() => startDeliveryGoal(other, `Q-${NUM.anna}`));
    check("somebody who can't open the quote is refused", !notHis.ok && /can't find that quote/.test(notHis.error), JSON.stringify(notHis));
    const started = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.anna}`));
    annaGoal = started.ok ? started.id : "";
    const row = await goal(annaGoal);
    check("set: an AssistantTask of kind delivery_goal, the person's, in their workspace, waiting on the deposit",
      started.ok && row?.kind === "delivery_goal" && row.tenantId === T && row.userId === rep.id && row.quoteId === Q.anna && row.nextAction === "Waiting on the deposit",
      JSON.stringify({ started, row: row && { kind: row.kind, next: row.nextAction } }));
    const again = await scoped(() => startDeliveryGoal(rep, String(NUM.anna)));
    check("setting it twice finds the same goal", again.ok && again.existing && again.id === annaGoal, JSON.stringify(again));
    check("it is on the Ask page, in its own section", (await scoped(() => goalsForAskPage(rep.id))).some((g) => g.id === annaGoal));
    check("…not in the job sheets, nor in front of a question", !(await scoped(() => tasksForAskPage(rep.id))).some((t) => t.id === annaGoal) && !(await scoped(() => openTasks(rep))).some((t) => t.id === annaGoal));
  }

  // The reminders that exist when it finishes. The goal's own: rep's watches on this quote and its deal, and the
  // DAX check-back naming Q-n. NOT its own: rep's unrelated watch, rep's own scheduled question naming Q-n, a DAX
  // check-back about another quote, and OTHER's watch and check-back on the same quote.
  const W = { quote: id("w-quote"), lead: id("w-lead"), unrelated: id("w-unrel"), others: id("w-others") };
  const S = { dax: id("s-dax"), daxOther: id("s-daxother"), mine: id("s-mine"), others: id("s-others") };
  await basePrisma.assistantWatch.createMany({
    data: [
      { id: W.quote, tenantId: T, userId: rep.id, kind: "quote_unsigned", quoteId: Q.anna, thresholdHours: 48, label: "w" },
      { id: W.lead, tenantId: T, userId: rep.id, kind: "lead_quiet", leadId: L.anna, thresholdDays: 7, label: "w" },
      { id: W.unrelated, tenantId: T, userId: rep.id, kind: "lead_quiet", thresholdDays: 7, label: "w" },
      { id: W.others, tenantId: T, userId: other.id, kind: "quote_unsigned", quoteId: Q.anna, thresholdHours: 48, label: "w" },
    ],
  });
  const later = new Date(Date.now() + 3 * 86_400_000);
  await basePrisma.assistantSchedule.createMany({
    data: [
      { id: S.dax, tenantId: T, userId: rep.id, setBy: "dax", cadence: "once", timeOfDay: "09:00", nextRunAt: later, question: `Has Anna paid the deposit on Q-${NUM.anna}?` },
      { id: S.daxOther, tenantId: T, userId: rep.id, setBy: "dax", cadence: "once", timeOfDay: "09:00", nextRunAt: later, question: `Has Ben signed Q-${NUM.ben}0?` },
      { id: S.mine, tenantId: T, userId: rep.id, setBy: "person", cadence: "weekly", weekday: 1, timeOfDay: "07:00", nextRunAt: later, question: `How is Q-${NUM.anna} going?` },
      { id: S.others, tenantId: T, userId: other.id, setBy: "dax", cadence: "once", timeOfDay: "09:00", nextRunAt: later, question: `Check Q-${NUM.anna}` },
    ],
  });

  console.log("\nFollowing it: deposit → documents → prep → booking → delivered");
  {
    const first = await tick();
    const after = await goal(annaGoal);
    check("the first pass checks it and tells nothing (they were told the blocker when they set it)", first.checked === 1 && (await alertsOf(annaGoal)).length === 0 && Boolean((after?.details as { checkedAt?: string }).checkedAt), JSON.stringify(first));
    const second = await tick();
    check("a pass straight after finds it freshly checked and does nothing", second.checked === 0, JSON.stringify(second));

    await quoteUpdate(Q.anna, { depositPaidAt: new Date(), depositPaidCents: 1_000_000 });
    await unfresh(annaGoal);
    // In working hours whatever the clock says, so the sending path always runs.
    await atSaHour(10, () => tick());
    const a1 = await alertsOf(annaGoal);
    check("deposit in: news once — the next blocker is the invoice", a1.length === 1 && /^next:documents:/.test(a1[0].key) && /Next: the invoice/.test(a1[0].text) && (await goal(annaGoal))?.nextAction === "Waiting on the invoice", JSON.stringify(a1.map((a) => a.key)));
    const turn = await basePrisma.assistantTurn.findFirst({ where: { userId: rep.id, source: "proactive" }, orderBy: { createdAt: "desc" } });
    check("sent through proactive DAX: in the person's thread, labelled as a delivery they follow, with the deal's link",
      a1[0].deliveredAt !== null && a1[0].turnId === turn?.id && turn?.question === "A delivery you're following" && turn.answer.includes(`/deals/${Q.anna}`), JSON.stringify(turn));

    // Three days on the invoice: a stall, told once — found at night, so held for the morning.
    // Four days back: at least three before "22:00 today", whatever the time now.
    await unfresh(annaGoal, { since: new Date(Date.now() - 4 * 86_400_000).toISOString() });
    await atSaHour(22, () => tick());
    await unfresh(annaGoal);
    await atSaHour(22, () => tick());
    const a2 = await alertsOf(annaGoal);
    const stall = a2.filter((a) => a.key.startsWith("stall:documents:"));
    check("three days waiting on the invoice: a stall, told once, saying where to act", stall.length === 1 && /Issue the invoice on the Deliveries board/.test(stall[0].text), JSON.stringify(a2.map((a) => a.key)));
    check("…at night it is held for the morning (proactive DAX's quiet hours), not sent", stall[0]?.deliverAt !== null && stall[0]?.deliveredAt === null && stall[0]?.turnId === null);

    // Two cron passes at once.
    await quoteUpdate(Q.anna, { invoicedAt: new Date() });
    await unfresh(annaGoal);
    const v0 = (await goal(annaGoal))?.version ?? -1;
    const both = await Promise.all([tick(), tick()]);
    const a3 = await alertsOf(annaGoal);
    check("two passes at once: one checks it, the other waits on the row lock and does nothing — ONE alert",
      both.reduce((n, r) => n + r.checked, 0) === 1 && a3.filter((a) => a.key.startsWith("next:prep:")).length === 1 && (await goal(annaGoal))?.version === v0 + 1,
      JSON.stringify({ both, keys: a3.map((a) => a.key) }));

    // The same, made certain: another pass HOLDS the goal's row while this one starts. It must wait, then find the
    // goal freshly checked and leave it alone.
    await unfresh(annaGoal);
    let settled = false;
    let waiting: Promise<Awaited<ReturnType<typeof tick>>> | null = null;
    await basePrisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "AssistantTask" WHERE "id" = ${annaGoal} FOR UPDATE`;
      waiting = tick().finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const held = await tx.assistantTask.findUnique({ where: { id: annaGoal }, select: { details: true } });
      await tx.assistantTask.update({ where: { id: annaGoal }, data: { details: { ...(held?.details as object), checkedAt: new Date().toISOString() } } });
    }, { timeout: 10_000 });
    const blockedWhileHeld = !settled;
    const waited = await waiting!;
    check("a pass that meets the row locked waits for it, then finds it checked and does nothing", blockedWhileHeld && waited.checked === 0 && (await alertsOf(annaGoal)).length === a3.length, JSON.stringify({ blockedWhileHeld, waited }));

    // Off, then On.
    await scoped(() => setGoalPaused(rep.id, annaGoal, true));
    await basePrisma.stockUnit.create({ data: { id: UNIT.anna, tenantId: T, productId: PRODUCT, status: "sold", soldQuoteId: Q.anna, pdiStatus: "passed" } });
    const paused = await tick();
    check("Off: not checked, nothing told", paused.checked === 0 && (await alertsOf(annaGoal)).length === a3.length);
    check("…and someone else can't switch it back on, or close it", !(await scoped(() => setGoalPaused(other.id, annaGoal, false))) && !(await scoped(() => closeGoal(other.id, annaGoal))) && (await goal(annaGoal))?.status === "open");
    await scoped(() => setGoalPaused(rep.id, annaGoal, false));
    await tick();
    check("On again: the cart's PDI passed is news — next, a delivery date", (await alertsOf(annaGoal)).some((a) => a.key.startsWith("next:booking:")));

    await quoteUpdate(Q.anna, { deliveryScheduledFor: new Date(Date.now() + 86_400_000) });
    await unfresh(annaGoal);
    await tick();
    // Something still waiting to be sent when it finishes (as if held overnight): dropped, never sent.
    await basePrisma.assistantProactiveAlert.create({
      data: { tenantId: T, userId: rep.id, kind: "delivery_goal", recordKey: `${annaGoal}:held-test`, text: "held", deliverAt: new Date(Date.now() + 12 * 3_600_000) },
    });

    console.log("\nDelivered: done, and its own reminders switched off in the same transaction");
    await quoteUpdate(Q.anna, { deliveredAt: new Date() });
    await unfresh(annaGoal);
    // ONE transaction: the goal can't be marked done (a failure at its very last write) → the reminders it had
    // already switched off and the alert it had made are undone with it. Nothing half-finished.
    const since = new Date();
    await basePrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION goal_test_fail() RETURNS trigger AS $$ BEGIN
      IF NEW."id" = '${annaGoal}' AND NEW."status" = 'done' THEN RAISE EXCEPTION 'simulated goal failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await basePrisma.$executeRawUnsafe(`CREATE TRIGGER goal_test_fail BEFORE UPDATE ON "AssistantTask" FOR EACH ROW EXECUTE FUNCTION goal_test_fail()`);
    try {
      await atSaHour(10, () => tick());
    } finally {
      await basePrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS goal_test_fail ON "AssistantTask"`);
      await basePrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS goal_test_fail()`);
    }
    const halfway = await basePrisma.assistantWatch.findMany({ where: { id: { in: [W.quote, W.lead] } }, select: { active: true } });
    check("the finish fails at its last write: the goal stays open, its watches and check-back stay on, no alert — all or nothing",
      (await goal(annaGoal))?.status === "open" && halfway.every((w) => w.active) && (await basePrisma.assistantSchedule.findUnique({ where: { id: S.dax } }))?.active === true && !(await alertsOf(annaGoal)).some((a) => a.key === "done"));
    await basePrisma.errorLog.deleteMany({ where: { scope: "assistant-goal", createdAt: { gte: since } } });
    await unfresh(annaGoal);
    const finishing = await atSaHour(10, () => Promise.all([tick(), tick()]));
    const row = await goal(annaGoal);
    const watches = await basePrisma.assistantWatch.findMany({ where: { id: { in: Object.values(W) } } });
    const schedules = await basePrisma.assistantSchedule.findMany({ where: { id: { in: Object.values(S) } } });
    const on = (wid: string) => watches.find((w) => w.id === wid)?.active ?? schedules.find((s) => s.id === wid)?.active;
    const a4 = await alertsOf(annaGoal);
    check("done: the goal is finished once, even with two passes at once", row?.status === "done" && row.closedAt !== null && finishing.reduce((n, r) => n + r.finished, 0) === 1 && a4.filter((a) => a.key === "done").length === 1, JSON.stringify(finishing));
    check("its own watches (on the quote, on the deal) are off", on(W.quote) === false && on(W.lead) === false);
    check("its own DAX check-back naming the quote is off", on(S.dax) === false && schedules.find((s) => s.id === S.dax)?.nextRunAt === null);
    check("NOT its own: the unrelated watch, a check-back about another quote, the person's own question — all still on", on(W.unrelated) === true && on(S.daxOther) === true && on(S.mine) === true);
    check("another person's watch and check-back on the same quote are untouched", on(W.others) === true && on(S.others) === true);
    const held = a4.find((a) => a.key === "held-test");
    check("what it had not yet sent is dropped, never sent", held?.deliveredAt !== null && held?.turnId === null);
    check("the done note says what it switched off", /switched off 2 watches and 1 check-back/.test(a4.find((a) => a.key === "done")?.text ?? "") && /switched off 2 watches and 1 check-back/.test(row?.nextAction ?? ""), row?.nextAction ?? "");
    const once = await tick();
    check("finished: no longer checked", once.checked === 0);

    // The eval scenario, scored on what the database shows.
    const scenario = GOAL_SCENARIOS.find((s) => s.id === "delivery-completes-and-stops-reminders")!;
    const score = scoreGoalScenario(scenario, {
      status: row?.status ?? "missing",
      alerts: a4.filter((a) => a.key !== "held-test" && !a.key.startsWith("stall:")).map((a) => a.key),
      ownRemindersOn: [W.quote, W.lead, S.dax].filter((x) => on(x)).length,
      othersChanged: [W.unrelated, W.others, S.daxOther, S.mine, S.others].filter((x) => !on(x)).length,
      pendingAlerts: (await alertsOf(annaGoal)).filter((a) => a.deliveredAt === null).length,
      customerMessages: await customerMessages(),
    });
    check(`eval ${scenario.id}: 100`, score.score === 100, formatReport([score]));
  }

  console.log("\nThe deal is lost");
  {
    const started = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.ben}`));
    const benGoal = started.ok ? started.id : "";
    const bw = id("w-ben");
    await basePrisma.assistantWatch.create({ data: { id: bw, tenantId: T, userId: rep.id, kind: "quote_unsigned", quoteId: Q.ben, thresholdHours: 48, label: "w" } });
    await basePrisma.lead.update({ where: { id: L.ben }, data: { status: "lost" } });
    await tick();
    const row = await goal(benGoal);
    check("lost: closed with why, its watch switched off, told once", row?.status === "closed" && row.nextAction?.startsWith("Deal lost") === true && (await basePrisma.assistantWatch.findUnique({ where: { id: bw } }))?.active === false && (await alertsOf(benGoal)).filter((a) => a.key === "lost").length === 1, row?.nextAction ?? "");
  }

  console.log("\nAnother person, another workspace, access, the module");
  {
    // Other's own goal, on their own quote.
    const theirs = await scoped(() => startDeliveryGoal(other, `Q-${NUM.others}`));
    const theirGoal = theirs.ok ? theirs.id : "";
    check("another person sets their own", theirs.ok);
    check("rep can't switch it off or close it", !(await scoped(() => setGoalPaused(rep.id, theirGoal, true))) && !(await scoped(() => closeGoal(rep.id, theirGoal))));
    check("…nor see it", !(await scoped(() => goalsForAskPage(rep.id))).some((g) => g.id === theirGoal));
    const before = await goal(theirGoal);
    const elsewhere = await tick(OTHER_TENANT);
    const mismatched = await scoped(() => runDeliveryGoals(T, budget), OTHER_TENANT);
    check("a pass in another workspace reaches none of this workspace's goals", elsewhere.checked === 0 && mismatched.checked === 0 && (await goal(theirGoal))?.version === before?.version);
    check("…and that workspace can't find them on its Ask page", (await scoped(() => goalsForAskPage(other.id), OTHER_TENANT)).length === 0);

    // Access lost: rep's quote for somebody else's customer, handed to someone else.
    const lapsed = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.lapsed}`));
    const lapsedGoal = lapsed.ok ? lapsed.id : "";
    await quoteUpdate(Q.lapsed, { createdById: other.id });
    await tick();
    const lrow = await goal(lapsedGoal);
    check("access lost: the goal stops itself, says why, and tells nothing", lapsed.ok && lrow?.status === "closed" && /can no longer open this deal/.test(lrow.nextAction ?? "") && (await alertsOf(lapsedGoal)).length === 0, lrow?.nextAction ?? "");

    // The Automotive module off.
    const mod = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.modular}`));
    const modGoal = mod.ok ? mod.id : "";
    await basePrisma.tenant.update({ where: { id: T }, data: { modules: granted.split(",").filter((m) => m !== "automotive").join(",") } });
    await quoteUpdate(Q.modular, { depositPaidAt: new Date() });
    const v = (await goal(modGoal))?.version;
    const offPass = await tick();
    check("module off: nothing checked, nothing told, the goal exactly as it was", offPass.checked === 0 && (await goal(modGoal))?.version === v && (await alertsOf(modGoal)).length === 0, JSON.stringify(offPass));
    const refused = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.ben}`));
    check("…and new goals are refused", !refused.ok && /Automotive module/.test(refused.error));
    await basePrisma.tenant.update({ where: { id: T }, data: { modules: granted } });
    await tick();
    check("module back on: it picks up where it was", (await alertsOf(modGoal)).some((a) => a.key.startsWith("next:documents:")));
    check("Close: closed by the person", await scoped(() => closeGoal(rep.id, modGoal)) && (await goal(modGoal))?.nextAction === "Closed by you");
  }

  console.log("\nProactive DAX switched off: the goal is paused, and nothing happens that nobody hears about (review of #922)");
  {
    const started = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.quiet}`));
    const quietGoal = started.ok ? started.id : "";
    const qw = id("w-quiet");
    await basePrisma.assistantWatch.create({ data: { id: qw, tenantId: T, userId: rep.id, kind: "quote_unsigned", quoteId: Q.quiet, thresholdHours: 48, label: "w" } });
    await atSaHour(10, () => tick());
    await setSetting(proactivePersonKey(rep.id), "off");
    await quoteUpdate(Q.quiet, { depositPaidAt: new Date(), invoicedAt: new Date(), deliveryScheduledFor: new Date(), deliveredAt: new Date() });
    await unfresh(quietGoal);
    const v = (await goal(quietGoal))?.version;
    const offPass = await atSaHour(10, () => tick());
    const row = await goal(quietGoal);
    check("switched off, then delivered: the pass leaves it exactly as it was — open, not advanced, no alert, its watch still on",
      offPass.paused >= 1 && row?.status === "open" && row.version === v && (await alertsOf(quietGoal)).length === 0 && (await basePrisma.assistantWatch.findUnique({ where: { id: qw } }))?.active === true,
      JSON.stringify(offPass));
    check("…and the Ask page shows it paused because proactive DAX is off", (await scoped(() => goalsForAskPage(rep.id))).find((g) => g.id === quietGoal)?.proactiveOff === true);
    await setSetting(proactivePersonKey(rep.id), "on");
    await atSaHour(10, () => tick());
    const after = await goal(quietGoal);
    const alerts = await alertsOf(quietGoal);
    check("switched back on: the next pass tells where it stands — ONE done alert, sent — finishes it and switches its reminders off",
      alerts.length === 1 && alerts[0].key === "done" && alerts[0].turnId !== null && after?.status === "done" && (await basePrisma.assistantWatch.findUnique({ where: { id: qw } }))?.active === false,
      JSON.stringify(alerts.map((a) => a.key)));
    check("…and the page no longer says paused", (await scoped(() => goalsForAskPage(rep.id))).find((g) => g.id === quietGoal)?.proactiveOff === false);
  }

  console.log("\nRetention: the nightly maintenance (pruneAssistantTasks, as the automations cron runs it)");
  {
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const open15 = await scoped(() => startDeliveryGoal(rep, `Q-${NUM.aged}`));
    const g15 = open15.ok ? open15.id : "";
    await basePrisma.assistantTask.update({ where: { id: g15 }, data: { updatedAt: daysAgo(15), createdAt: daysAgo(15) } });
    const mk = (what: string, data: Record<string, unknown>) =>
      basePrisma.assistantTask.create({ data: { id: id(what), tenantId: T, userId: rep.id, title: what, details: {}, steps: {}, kind: "delivery_goal", ...data }, select: { id: true } });
    const g31 = (await mk("g31", { status: "open", quoteId: Q.aged, updatedAt: daysAgo(31), createdAt: daysAgo(31) })).id;
    const done31 = (await mk("done31", { status: "done", updatedAt: daysAgo(40), closedAt: daysAgo(31) })).id;
    const done10 = (await mk("done10", { status: "closed", updatedAt: daysAgo(40), closedAt: daysAgo(10) })).id;
    const sheet15 = (await mk("sheet15", { kind: "quote", status: "open", updatedAt: daysAgo(15) })).id;
    const sheet31 = (await mk("sheet31", { kind: "quote", status: "closed", updatedAt: daysAgo(31), closedAt: daysAgo(17) })).id;
    const swept = await withSystemScope(() => pruneAssistantTasks());
    const exists = async (tid: string) => (await basePrisma.assistantTask.findUnique({ where: { id: tid }, select: { status: true } }))?.status ?? null;
    check("open goals 15 and 31 days quiet survive, still open", (await exists(g15)) === "open" && (await exists(g31)) === "open", JSON.stringify(swept));
    check("a goal finished over 30 days ago is removed; one finished 10 days ago stays (measured from when it finished)", (await exists(done31)) === null && (await exists(done10)) === "closed");
    check("job sheets keep their rule: 15 days quiet → closed, 31 → removed", (await exists(sheet15)) === "closed" && (await exists(sheet31)) === null);
  }

  console.log(`\nMore open goals than one pass takes (${GOAL_BATCH}): every one is checked in turn, the newest too (review of #922)`);
  {
    const n = GOAL_BATCH + 5;
    const base = Date.now();
    const bulk = Array.from({ length: n }, (_, i) => id(`bulk-${String(i).padStart(3, "0")}`));
    // Unchanged deliveries (waiting on the deposit, as they were set up): a check finds nothing new on any of them.
    await basePrisma.assistantTask.createMany({
      data: bulk.map((gid, i) => ({
        id: gid, tenantId: T, userId: rep.id, kind: "delivery_goal", title: "bulk", status: "open", quoteId: Q.aged,
        details: { blocker: "deposit", since: new Date(base).toISOString(), told: [] }, steps: {},
        // Oldest first; the last is the newest goal.
        updatedAt: new Date(base - (n - i) * 60_000), createdAt: new Date(base - (n - i) * 60_000),
      })),
    });
    const checked = async () =>
      (await basePrisma.assistantTask.findMany({ where: { id: { in: bulk } }, select: { details: true } })).filter((r) => Boolean((r.details as { checkedAt?: string }).checkedAt)).length;
    const alertsBefore = await basePrisma.assistantProactiveAlert.count({ where: { userId: rep.id } });
    const first = await Promise.all([tick(), tick()]);
    const afterFirst = await checked();
    const second = await tick();
    const newest = await goal(bulk[n - 1]);
    check(`two passes at once take one batch between them (${afterFirst} of ${n} checked), the next pass the rest`,
      afterFirst >= GOAL_BATCH - 5 && afterFirst < n && (await checked()) === n, JSON.stringify({ first, second, afterFirst }));
    check("…including the newest goal", Boolean((newest?.details as { checkedAt?: string }).checkedAt));
    check("…and nothing new on any of them means no alert at all", (await basePrisma.assistantProactiveAlert.count({ where: { userId: rep.id } })) === alertsBefore);
    await basePrisma.assistantTask.deleteMany({ where: { id: { in: bulk } } });
  }

  console.log("\nNever the customer");
  check("no message, email or anything else reached a customer", (await customerMessages()) === 0);
  const goals = await basePrisma.assistantTask.findMany({ where: { userId: { in: [rep.id, other.id] }, kind: "delivery_goal" }, select: { id: true, userId: true } });
  const misaddressed = (await Promise.all(goals.map(async (g) => (await alertsOf(g.id)).filter((a) => a.userId !== g.userId || a.tenantId !== T).length))).reduce((n, x) => n + x, 0);
  check("every alert went to the person who set the goal, in their workspace", goals.length >= 5 && misaddressed === 0, `${misaddressed} of ${goals.length} goals`);
}

main()
  .catch((error) => { failed++; console.error("\nUNEXPECTED ERROR", error); })
  .finally(async () => {
    __setTenantEnforcingForTests(null);
    await cleanup().catch((error) => { failed++; console.error("cleanup failed", error); });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  });
