import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/journeyLeadSpy";
import {
  JOURNEY_LIMITS,
  JOURNEY_STEP_LABELS,
  LEAD_OUTCOME_STEP_TYPES,
  isLeadOutcomeStep,
  parseJourneyDefinition,
  parseLeadOutcomeConfig,
} from "../src/lib/journeyTypes";
import {
  LEAD_OUTCOME_PLANS,
  applyLeadOutcome,
  cappedLostReason,
  leadOutcomeWhere,
  type LeadOutcomeData,
  type LeadOutcomeWhere,
  type LeadOutcomeWriter,
} from "../src/lib/journeyLeadOutcome";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** Strip comments, or a guard passes on the prose that documents it. */
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * Load the REAL `journeyStepExecutor.ts` by intercepting the module loader.
 *
 * The executor is `server-only` by transitive import and builds a live
 * PrismaClient through `./db`, so the unit runner cannot load it as shipped.
 * tsx compiles these tests to CommonJS, so both are swapped here and the real
 * module is then required through the patched loader — which buys BEHAVIOURAL
 * tests of the shipped step: its real control flow, its real where clauses, run
 * against an in-memory table.
 *
 * `./db` is swapped for EVERY requester, not just the executor, and that is
 * deliberate rather than lazy: `.env` in this repo points at the production
 * database, and a real PrismaClient must never be constructed by a unit test.
 * The fan-out modules are anchored on the executor's own filename, so the spy
 * cannot be handed to some other module that happens to import audit or push.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "./db" || request === "@/lib/db") {
    return { prisma: spy.prisma, basePrisma: spy.prisma };
  }
  if (parent?.filename?.endsWith("journeyStepExecutor.ts") && spy.modules[request]) {
    return spy.modules[request];
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const executor = createRequire(import.meta.url)(
  "../src/lib/journeyStepExecutor.ts",
) as typeof import("../src/lib/journeyStepExecutor");

/** A journey context for a lead, in the compacted shape the runner passes. */
type Ctx = {
  event: Record<string, unknown>;
  lead: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
};

function context(overrides: Record<string, unknown> = {}): Ctx {
  return {
    event: {},
    lead: { id: "lead_1", title: "Two carts", name: "Thandi Mokoena", ...overrides },
    contact: null,
  };
}

/** Run one step through the shipped executor. */
function runStep(args: {
  type: string;
  config?: Record<string, unknown>;
  tenantId?: string | null;
  ctx?: Ctx;
}) {
  return executor.executeJourneyStep({
    step: { id: "step_1", type: args.type as never, config: args.config ?? {} },
    context: args.ctx ?? context(),
    category: "sales",
    journeyName: "Quote follow-up",
    runId: "run_1",
    tenantId: args.tenantId === undefined ? "tenant_a" : args.tenantId,
  });
}

const openLead = (overrides: Partial<spy.LeadRow> = {}): spy.LeadRow => ({
  id: "lead_1",
  tenantId: "tenant_a",
  status: "open",
  lostReason: null,
  deletedAt: null,
  stageId: "stage_new",
  position: 3,
  assignedToId: null,
  ...overrides,
});

/**
 * The lead OUTCOME steps: mark won, mark lost, reopen.
 *
 * `lead_won` and `lead_lost` were both enrolment TRIGGERS with no step on the
 * other side of them — a journey could react to a win and could not cause one.
 *
 * Almost everything below is BEHAVIOURAL. `leadTable()` is Prisma's matching for
 * exactly the where clause this code builds, with the database removed, so these
 * exercise the real predicate rather than reading the source and hoping. The
 * handful of source-scanning tests at the end cover the two things a behavioural
 * test cannot reach: journeyStepExecutor imports the mail provider and
 * `server-only`, and the runner is what decides which tenant is handed to it.
 */

type LeadRow = {
  id: string;
  tenantId: string | null;
  status: string;
  lostReason: string | null;
  deletedAt: Date | null;
};

function lead(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    id: "lead_1",
    tenantId: "tenant_a",
    status: "open",
    lostReason: null,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * The rows a `LeadOutcomeWriter` writes to, matching the way Postgres would.
 *
 * `row.tenantId === where.tenantId` is the load-bearing line: `tenantId: null`
 * renders as `IS NULL`, NOT as "no filter". That distinction is the whole reason
 * the key is present in the where clause even when its value is null, and a fake
 * that treated null as a wildcard would make the cross-tenant test below pass
 * for the wrong reason.
 */
function leadTable(rows: LeadRow[]) {
  const calls: Array<{ where: LeadOutcomeWhere; data: LeadOutcomeData }> = [];
  const updateLead: LeadOutcomeWriter = async ({ where, data }) => {
    calls.push({ where, data });
    const matched = rows.filter(
      (row) =>
        row.id === where.id &&
        row.tenantId === where.tenantId &&
        row.deletedAt === where.deletedAt &&
        where.status.in.includes(row.status),
    );
    for (const row of matched) Object.assign(row, data);
    return { count: matched.length };
  };
  return { rows, calls, updateLead };
}

/* ══ 1. the transition table is the idempotency argument ══════════════════ */

test("no outcome step lists its own destination as a starting status", () => {
  // THE CLASS INVARIANT, asserted over the whole table rather than per step, so
  // a fourth outcome step cannot be added without it. `from` excluding `to` is
  // the entire reason marking an already-won lead won is a no-op instead of a
  // second win with a fresh updatedAt — which every won-this-month figure in the
  // app buckets by.
  for (const type of LEAD_OUTCOME_STEP_TYPES) {
    const plan = LEAD_OUTCOME_PLANS[type];
    assert.ok(
      !plan.from.includes(plan.to),
      `${type} would re-apply to a lead already ${plan.to} — that is a double-apply, not idempotence`,
    );
    assert.ok(plan.from.length > 0, `${type} can never match anything`);
  }
});

test("every outcome step names a tenant in its where clause, null included", () => {
  for (const type of LEAD_OUTCOME_STEP_TYPES) {
    for (const tenantId of ["tenant_a", null]) {
      const where = leadOutcomeWhere(type, "lead_1", tenantId);
      assert.ok(
        "tenantId" in where,
        `${type} builds a where clause with no tenant key — with the db.ts guard dormant that is "any lead with this id"`,
      );
      assert.equal(where.tenantId, tenantId);
      assert.equal(where.deletedAt, null, `${type} must not be able to mutate a lead in Trash`);
      assert.equal(where.id, "lead_1");
    }
  }
});

/* ══ 2. idempotence, by construction ══════════════════════════════════════ */

test("winning an open lead applies once and is a clean no-op forever after", async () => {
  const table = leadTable([lead()]);
  const first = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(first.applied, true);
  assert.equal(first.status, "completed");
  assert.equal(table.rows[0].status, "won");

  // The retry. A run is picked up by whichever process drains the queue, and a
  // `wait` can park it for thirty days first, so this is the ordinary case and
  // not an edge one.
  const second = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(second.applied, false, "a second win would earn the referral fee twice");
  assert.equal(second.status, "skipped", "and it must be RECORDED as skipped, not thrown");
  assert.equal(table.rows[0].status, "won", "the row is untouched");
  assert.equal(table.calls.length, 2, "the guard is the where clause, not a pre-read");
});

test("reopening an already-open lead is a no-op too", async () => {
  const table = leadTable([lead({ status: "open" })]);
  const result = await applyLeadOutcome({
    type: "lead_reopen",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, "skipped");
});

test("an outcome step never overturns the other outcome silently", async () => {
  const table = leadTable([lead({ status: "lost", lostReason: "Too expensive" })]);
  const straightToWon = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(straightToWon.applied, false, "lost → won must not be a one-step, unexplained revision");
  assert.equal(table.rows[0].status, "lost");

  // …and the transition is still expressible, it just has to be written down —
  // which is one extra audit line saying the lead was reopened.
  const reopened = await applyLeadOutcome({
    type: "lead_reopen",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(reopened.applied, true);
  assert.equal(table.rows[0].status, "open");
  assert.equal(table.rows[0].lostReason, null, "a reopened lead that keeps its lost reason still reads as lost");

  const won = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(won.applied, true);
  assert.equal(table.rows[0].status, "won");
});

/* ══ 3. tenant isolation ══════════════════════════════════════════════════ */

test("a journey step cannot close another workspace's lead", async () => {
  // The one that matters. `tenantEnforcing()` is false in every deployed
  // environment, so the db.ts guard rewrites nothing and RLS is bypassed — a
  // `where: { id: leadId }` really does mean "any lead in the database with this
  // id". The run's own tenant is the only boundary there is.
  const table = leadTable([lead({ id: "lead_1", tenantId: "tenant_b", status: "open" })]);
  const result = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "lead_1",
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, "skipped");
  assert.equal(table.rows[0].status, "open", "tenant B's deal was closed by tenant A's journey");
  assert.equal(
    table.calls[0].where.tenantId,
    "tenant_a",
    "the predicate must be sent to the database, not merely checked in memory",
  );
});

test("a legacy run with no tenant reaches legacy leads only", async () => {
  // `tenantId: null` is a filter (IS NULL), not an absent one. Both directions
  // matter: pre-tenancy rows must stay reachable by pre-tenancy runs, and a
  // null-tenant run must not become a skeleton key for every stamped tenant.
  const table = leadTable([
    lead({ id: "legacy", tenantId: null }),
    lead({ id: "stamped", tenantId: "tenant_a" }),
  ]);

  const legacy = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "legacy",
    tenantId: null,
    updateLead: table.updateLead,
  });
  assert.equal(legacy.applied, true);

  const reach = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: "stamped",
    tenantId: null,
    updateLead: table.updateLead,
  });
  assert.equal(reach.applied, false, "a null tenant must not match a stamped row");
  assert.equal(table.rows[1].status, "open");
});

test("a lead in Trash is left alone", async () => {
  const table = leadTable([lead({ deletedAt: new Date() })]);
  const result = await applyLeadOutcome({
    type: "lead_mark_lost",
    leadId: "lead_1",
    tenantId: "tenant_a",
    reason: "Gone quiet",
    updateLead: table.updateLead,
  });
  assert.equal(result.applied, false);
  assert.equal(table.rows[0].status, "open");
});

/* ══ 4. a run with no lead skips cleanly ══════════════════════════════════ */

test("a run that is not about a lead skips without writing anything", async () => {
  // Every contact-triggered journey is one of these: purchase_anniversary and
  // win_back enrol a CONTACT, so `run.leadId` is null. Failing the run there
  // would strand every step after the outcome step, for a journey that is
  // perfectly reasonable to build.
  const table = leadTable([lead()]);
  const result = await applyLeadOutcome({
    type: "lead_mark_won",
    leadId: null,
    tenantId: "tenant_a",
    updateLead: table.updateLead,
  });
  assert.equal(result.applied, false);
  assert.equal(result.status, "skipped");
  assert.match(result.note, /not about a lead/);
  assert.equal(table.calls.length, 0, "no lead means no write at all, not a write that matches nothing");
});

/* ══ 5. the lost reason ═══════════════════════════════════════════════════ */

test("a lost reason is written, and a missing one refuses at run time too", async () => {
  const table = leadTable([lead()]);
  const missing = await applyLeadOutcome({
    type: "lead_mark_lost",
    leadId: "lead_1",
    tenantId: "tenant_a",
    reason: "   ",
    updateLead: table.updateLead,
  });
  assert.equal(missing.applied, false);
  assert.equal(table.calls.length, 0, "an unexplained loss must never reach the column");

  const lost = await applyLeadOutcome({
    type: "lead_mark_lost",
    leadId: "lead_1",
    tenantId: "tenant_a",
    reason: "Went with a competitor",
    updateLead: table.updateLead,
  });
  assert.equal(lost.applied, true);
  assert.equal(table.rows[0].status, "lost");
  assert.equal(table.rows[0].lostReason, "Went with a competitor");
  assert.match(lost.note, /Went with a competitor/, "the trace must say WHY, not just that it happened");
});

test("the cap is applied to the RENDERED reason, not just the template", () => {
  // `"Lost to {{name}}"` is 16 characters of template and however many the
  // customer's name happens to be. Only the second one reaches the column.
  const long = cappedLostReason(`  ${"x".repeat(JOURNEY_LIMITS.leadOutcomeReason + 50)}  `);
  assert.equal(long.length, JOURNEY_LIMITS.leadOutcomeReason);
  assert.equal(cappedLostReason("  trimmed  "), "trimmed");
});

/* ══ 6. validation at save time ═══════════════════════════════════════════ */

const outcomeStep = (type: string, config: Record<string, unknown> = {}) => ({
  startStepId: "one",
  steps: [{ id: "one", type, nextStepId: null, config }],
});

test("the three steps parse, and mark-lost demands a reason", () => {
  assert.equal(parseJourneyDefinition(outcomeStep("lead_mark_won")).steps.length, 1);
  assert.equal(parseJourneyDefinition(outcomeStep("lead_reopen")).steps.length, 1);
  assert.equal(
    parseJourneyDefinition(outcomeStep("lead_mark_lost", { reason: "Budget cut" })).steps.length,
    1,
  );

  // Refused where the author is standing there to read it. Three days into a
  // parked run, "skipped: no reason configured" is a message nobody is watching.
  assert.throws(() => parseJourneyDefinition(outcomeStep("lead_mark_lost")), /needs a reason/);
  assert.throws(() => parseJourneyDefinition(outcomeStep("lead_mark_lost", { reason: "  " })), /needs a reason/);
  assert.throws(
    () =>
      parseJourneyDefinition(
        outcomeStep("lead_mark_lost", { reason: "x".repeat(JOURNEY_LIMITS.leadOutcomeReason + 1) }),
      ),
    /characters or fewer/,
  );
});

test("the config parse and the type guard agree on which steps are outcomes", () => {
  for (const type of LEAD_OUTCOME_STEP_TYPES) {
    assert.equal(isLeadOutcomeStep(type), true);
    assert.ok(JOURNEY_STEP_LABELS[type], `${type} has no human name, so nothing can offer it`);
  }
  for (const type of ["wait", "send_email", "move_stage", "assign_user"]) {
    assert.equal(isLeadOutcomeStep(type), false);
  }
  // Won and reopen take no configuration; a stray key is ignored, not rejected.
  assert.deepEqual(parseLeadOutcomeConfig("lead_mark_won", { reason: "ignored" }), { reason: null });
  assert.deepEqual(parseLeadOutcomeConfig("lead_reopen", {}), { reason: null });
});

/* ══ 7. what a behavioural test cannot reach ══════════════════════════════ */

test("every Lead write in the executor is a conditional updateMany naming the tenant", () => {
  // journeyStepExecutor imports the mail provider and `server-only`, so it
  // cannot be imported here at all. What matters is the SHAPE of its writes, and
  // that is readable: an `update({ where: { id } })` carries no tenant predicate
  // while the db.ts guard is dormant, and throws P2025 for a lead deleted while
  // the run was parked — failing the step and burning one of three attempts.
  const executor = shipped("src/lib/journeyStepExecutor.ts");
  assert.doesNotMatch(
    executor,
    /prisma\.lead\.update\(/,
    "update-by-id on a Lead is back — no tenant predicate, and P2025 on a deleted lead",
  );
  assert.doesNotMatch(executor, /prisma\.lead\.delete/, "a journey step must not delete a lead");

  const tails = executor.split("prisma.lead.updateMany(").slice(1).map((tail) => tail.slice(0, 400));
  assert.ok(tails.length >= 3, "expected the move_stage, assign_user and lead-outcome writes");
  for (const tail of tails) {
    assert.match(
      tail,
      /tenantId|updateArgs/,
      "a Lead write with no tenant in its where can close another workspace's deal",
    );
  }
});

test("the run's own tenant is what reaches the executor", () => {
  // Not the ambient scope (invisible to a `where` while the guard is dormant)
  // and not the journey context (a compacted snapshot that carries no tenant at
  // all — the same trap the consent gate fell into, where every marketing send
  // was blocked because the context's tenantId was always null).
  const runner = shipped("src/lib/journeyRuns.ts");
  const callAt = runner.indexOf("executeJourneyStep({");
  assert.ok(callAt > 0, "the executor call is not where this test expects it");
  const call = runner.slice(callAt, callAt + 500);
  assert.match(call, /tenantId: run\.tenantId/, "the executor must be told which tenant the run belongs to");
});

test("the audit action a step writes is the staff verb's own, not a second name", () => {
  // Genuinely cross-file, so genuinely a source comparison: one query on
  // "lead.won" has to cover both the button and the journey, or the lead's own
  // history shows a win that no report of wins can find.
  const outcomes = shipped("src/lib/journeyLeadOutcome.ts");
  const actions = shipped("src/app/actions/leads.ts");
  for (const action of ["lead.won", "lead.lost", "lead.reopened"]) {
    assert.ok(outcomes.includes(`"${action}"`), `${action} is not what the step records`);
    assert.ok(actions.includes(`"${action}"`), `${action} is not what the staff verb records`);
  }
});

/* ══ 8. the SHIPPED executor, run ═════════════════════════════════════════ */

/**
 * Everything above tests `applyLeadOutcome` — the row write and its guard.
 * These run `executeJourneyStep` ITSELF, because the question that matters is
 * not "is the gate written down" but "is the gate REACHED": a retry must earn no
 * second referral fee and emit no second `lead_won`, and no arrangement of the
 * surrounding control flow may let one through. A source grep asserting that
 * `markReferralEarned(` appears after `if (!outcome.applied)` cannot tell the
 * difference between a gate and a comment.
 */

test("the shipped step wins the lead and fires each effect exactly once", async () => {
  spy.reset([openLead()]);
  const result = await runStep({ type: "lead_mark_won" });

  assert.equal(result.status, "completed");
  assert.equal(spy.row("lead_1").status, "won");
  assert.deepEqual(
    spy.firedNames(),
    ["markReferralEarned", "emitLeadJourneyEvent", "logAudit"],
    "a win owes the referrer a fee, re-enters the engine, and is written down — in that order",
  );
  // The event is the one the builder already offers as a TRIGGER, so a
  // "when a lead is won" journey fires whether a rep, a signed quote or this
  // step produced the win.
  assert.equal(spy.fired("emitLeadJourneyEvent")[0].args[0], "lead_won");
  assert.equal(spy.fired("emitLeadJourneyEvent")[0].args[1], "lead_1");

  // NO explicit `occurrence`, and that is a decision rather than an omission.
  // `emitLeadJourneyEvent` defaults the dedupe key to the lead row's updatedAt,
  // which the write above just stamped — the documented-correct key for a
  // trigger emitted immediately after writing the lead, and the same one markWon
  // and setQuoteStatus use. A run+step key would be WRONG here: inside a
  // `repeat` that reopens and re-wins, the same step id genuinely wins the lead
  // twice and must enrol twice, and a key built from ids would silently collapse
  // the second win into the first. Re-emission on a RETRY is prevented by the
  // applied gate, not by the key — see the retry test below.
  const options = spy.fired("emitLeadJourneyEvent")[0].args[2] as Record<string, unknown>;
  assert.equal(options.occurrence, undefined, "an id-based key would collapse a genuine second win");
  assert.deepEqual(options.payload, { sourceRunId: "run_1", sourceStepId: "step_1" });
  // The trace has to carry the outcome, not just "completed" — `output` is what
  // updateStepLog stores and JourneyRunTrace renders.
  assert.equal((result.output as Record<string, unknown>).applied, true);
  assert.equal((result.output as Record<string, unknown>).to, "won");
});

test("a retried step re-applies nothing and fires no effect at all", async () => {
  // THE ONE THAT MATTERS. A run retries up to three times and a `wait` can park
  // it for thirty days first, so the process that resumes it is routinely not
  // the one that started it. A second pass must not be a second sale.
  spy.reset([openLead()]);
  await runStep({ type: "lead_mark_won" });
  const firstPass = spy.firedNames().length;

  const retry = await runStep({ type: "lead_mark_won" });

  assert.equal(retry.status, "skipped", "recorded as skipped, not thrown — a throw burns a run attempt");
  assert.equal(spy.row("lead_1").status, "won", "the row is untouched");
  assert.equal(
    spy.firedNames().length,
    firstPass,
    "the retry earned a second referral fee or emitted a second lead_won",
  );
  assert.equal(spy.fired("markReferralEarned").length, 1);
  assert.equal(spy.fired("emitLeadJourneyEvent").length, 1);
  assert.equal(spy.fired("logAudit").length, 1);
});

test("a journey step cannot close another workspace's lead, and fires nothing when it does not", async () => {
  // `tenantEnforcing()` is false in every deployed environment, so the db.ts
  // guard rewrites nothing and RLS is bypassed — `where: { id }` really does
  // mean "any lead in the database with this id". The run's own tenant is the
  // only boundary there is.
  spy.reset([openLead({ tenantId: "tenant_b" })]);
  const result = await runStep({ type: "lead_mark_won", tenantId: "tenant_a" });

  assert.equal(result.status, "skipped");
  assert.equal(spy.row("lead_1").status, "open", "tenant B's deal was closed by tenant A's journey");
  assert.deepEqual(spy.firedNames(), [], "tenant B's referrer was paid by tenant A's journey");
  assert.equal(
    spy.leadCalls[0].where.tenantId,
    "tenant_a",
    "the predicate must be SENT to the database, not merely checked in memory afterwards",
  );
});

test("the tenant predicate holds for every lead-writing step, not just the outcome ones", async () => {
  // The fix is a CLASS fix or it is nothing: move_stage and assign_user write to
  // the same table from the same runner with the same dormant guard, and both
  // used update-by-id.
  for (const [type, config] of [
    ["move_stage", { stageId: "stage_won" }],
    ["assign_user", { userId: "user_9" }],
  ] as const) {
    spy.reset([openLead({ tenantId: "tenant_b" })]);
    const result = await runStep({ type, config, tenantId: "tenant_a" });
    assert.equal(result.status, "skipped", `${type} touched another workspace's lead`);
    assert.equal(spy.row("lead_1").stageId, "stage_new", `${type} moved another workspace's lead`);
    assert.equal(spy.row("lead_1").assignedToId, null, `${type} reassigned another workspace's lead`);
    assert.deepEqual(spy.firedNames(), [], `${type} fanned out for a write that did not happen`);
    const write = spy.leadCalls.find((call) => call.op === "updateMany");
    assert.ok(write, `${type} made no conditional write`);
    assert.equal(write.where.tenantId, "tenant_a");
  }
});

test("a lead in Trash is left alone by the shipped step", async () => {
  spy.reset([openLead({ deletedAt: new Date() })]);
  const result = await runStep({ type: "lead_mark_won" });
  assert.equal(result.status, "skipped");
  assert.equal(spy.row("lead_1").status, "open");
  assert.deepEqual(spy.firedNames(), []);
});

test("a run that is not about a lead skips cleanly and writes nothing", async () => {
  // purchase_anniversary and win_back enrol a CONTACT, so `run.leadId` is null.
  // Failing here would strand every step after the outcome step.
  spy.reset([openLead()]);
  const result = await runStep({
    type: "lead_mark_won",
    ctx: { event: {}, lead: null, contact: { id: "contact_1" } },
  });
  assert.equal(result.status, "skipped");
  assert.match(result.note, /not about a lead/);
  assert.deepEqual(spy.leadCalls, [], "no lead means no write at all, not a write that matches nothing");
  assert.deepEqual(spy.firedNames(), []);
});

test("the lost reason is rendered from its template before it reaches the column", async () => {
  spy.reset([openLead()]);
  const result = await runStep({
    type: "lead_mark_lost",
    config: { reason: "{{name}} went with a competitor" },
  });
  assert.equal(result.status, "completed");
  assert.equal(spy.row("lead_1").status, "lost");
  assert.equal(
    spy.row("lead_1").lostReason,
    "Thandi Mokoena went with a competitor",
    "the template reached the column unrendered",
  );
  assert.equal(spy.fired("emitLeadJourneyEvent")[0].args[0], "lead_lost");
  assert.equal(spy.fired("markReferralEarned").length, 0, "a lost lead owes no referral fee");
});

test("a reason that RENDERS empty is refused, though its template was valid", async () => {
  // The save-time rule validates the template; only this can see the render.
  // `{{company}}` is an offered placeholder and a perfectly legal reason, and it
  // is empty for a contact with no company — so the rule that stops unexplained
  // losses has to be applied to the rendered string or it is not applied at all.
  spy.reset([openLead()]);
  const result = await runStep({ type: "lead_mark_lost", config: { reason: "{{company}}" } });

  assert.equal(result.status, "skipped");
  assert.equal(spy.row("lead_1").status, "open", "an unexplained loss was recorded anyway");
  assert.equal(spy.row("lead_1").lostReason, null);
  assert.deepEqual(spy.leadCalls, [], "an empty reason must not even be sent to the database");
  assert.deepEqual(spy.firedNames(), []);
});

test("reopening clears the lost reason and emits nothing, because no trigger exists", async () => {
  spy.reset([openLead({ status: "lost", lostReason: "Too expensive" })]);
  const result = await runStep({ type: "lead_reopen" });

  assert.equal(result.status, "completed");
  assert.equal(spy.row("lead_1").status, "open");
  assert.equal(spy.row("lead_1").lostReason, null, "a reopened lead that keeps its reason still reads as lost");
  assert.deepEqual(
    spy.firedNames(),
    ["logAudit"],
    "there is no lead_reopened trigger; inventing one puts an event in the stream nothing can wait for",
  );
});

test("the builder offers all three and explains when each is a no-op", () => {
  const builder = shipped("src/components/JourneyBuilder.tsx");
  // The type dropdown maps JOURNEY_STEP_LABELS, so being in that map IS being
  // offered — asserted in section 6 above. What needs its own check is the
  // config: a mark-lost step will not save without a reason, so the field has to
  // be on screen or the author meets a rejected save with nothing to fix.
  assert.match(builder, /step\.type === "lead_mark_lost"/, "no reason field — the step cannot be saved");
  assert.match(builder, /setConfig\(index, "reason", e\.target\.value\)/);
  assert.match(builder, /type === "lead_mark_lost" \? \{ reason: "" \}/, "picking the type must seed the field");
  // "Why did my step skip?" has exactly one answer and it should not need the
  // run trace to find it.
  for (const type of ["lead_mark_won", "lead_reopen"]) {
    assert.match(builder, new RegExp(`step\\.type === "${type}"`), `${type} has no on-screen explanation`);
  }
});
