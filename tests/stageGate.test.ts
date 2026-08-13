import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLEAR_VERDICT,
  MAX_STAGE_CRITERIA,
  STAGE_CRITERION_FIELDS,
  STAGE_CRITERION_KINDS,
  STAGE_CRITERION_LABELS,
  describeUnmet,
  evaluateStageMove,
  operatorsForField,
  parseStageCriteria,
  parseStageGateMode,
  refusalSentence,
  unmetCriteria,
  type StageCriteriaGroup,
  type StageGate,
  type StageGateFacts,
  type StageGateMode,
} from "../src/lib/stageGate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * Stage gates exist as a PURE module for the same reason `kanbanRules.ts` does:
 * a rule you cannot execute is a rule you cannot assert. Everything below runs
 * the real decision function against real fact snapshots — none of it is
 * pattern-matched against source, except the two structural guards at the end,
 * which are checking that no SECOND copy of the rules has appeared.
 */

/* ── fixtures ───────────────────────────────────────────────────────────── */

function facts(overrides: Partial<{
  quotes: number;
  sent: number;
  accepted: number;
  latestStatus: string | null;
  contactLinked: boolean;
  planned: number;
  overdue: number;
  ageDays: number;
  valueCents: number;
  assignedToId: string | null;
}> = {}): StageGateFacts {
  return {
    lead: {
      valueCents: overrides.valueCents ?? 0,
      assignedToId: overrides.assignedToId ?? null,
      productId: null,
      email: null,
      phone: null,
      source: "manual",
    },
    quote: {
      count: overrides.quotes ?? 0,
      sentCount: overrides.sent ?? 0,
      acceptedCount: overrides.accepted ?? 0,
      latestStatus: overrides.latestStatus ?? null,
    },
    contact: { linked: overrides.contactLinked ?? false, email: null, phone: null },
    activity: { plannedCount: overrides.planned ?? 0, overdueCount: overrides.overdue ?? 0 },
    signature: { completedCount: 0, pendingCount: 0 },
    stage: { ageDays: overrides.ageDays ?? 0 },
  };
}

/** "must have at least one quote" — the canonical rule this feature exists for. */
const NEEDS_QUOTE: StageCriteriaGroup = {
  logic: "and",
  conditions: [{ field: "quote.count", operator: "greater_or_equal", value: 1 }],
};

const gate = (mode: StageGateMode, criteria: StageCriteriaGroup | null = NEEDS_QUOTE): StageGate => ({
  mode,
  criteria,
});

/** Qualification (order 1) → Proposal (order 2), one pipeline. */
function move(input: {
  entry?: StageGate;
  exit?: StageGate;
  facts?: StageGateFacts;
  canOverride?: boolean;
  fromOrder?: number;
  toOrder?: number;
  samePipeline?: boolean;
}) {
  return evaluateStageMove({
    from: { stageId: "qualification", order: input.fromOrder ?? 1, exit: input.exit ?? gate("off", null) },
    to: { stageId: "proposal", order: input.toOrder ?? 2, entry: input.entry ?? gate("off", null) },
    samePipeline: input.samePipeline ?? true,
    facts: input.facts ?? facts(),
    canOverride: input.canOverride ?? false,
  });
}

/* ── the default: nothing changes ───────────────────────────────────────── */

test("a stage with no rule allows every move", () => {
  // The shipping state of every existing stage. This is the whole compatibility
  // story: the migration defaults the modes to "off" and the criteria to NULL,
  // and neither can block.
  assert.deepEqual(move({}), CLEAR_VERDICT);
});

test("criteria stored but the mode off is a hint, not a gate", () => {
  // The on-ramp: author a rule, watch it for a week, then turn it up. If "off"
  // enforced anything, nobody could ever safely write a rule to observe it.
  const verdict = move({ entry: gate("off"), facts: facts({ quotes: 0 }) });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.unmet.length, 0);
});

test("an empty condition list cannot block, whatever the mode says", () => {
  // `evaluateConditions` treats an empty group as "no filter". A mode left on
  // "block" after the last clause was deleted must not lock the column.
  const verdict = move({ entry: gate("block", { logic: "and", conditions: [] }) });
  assert.equal(verdict.allowed, true);
});

/* ── the four modes ─────────────────────────────────────────────────────── */

test("warn allows the move and still reports what was missing", () => {
  const verdict = move({ entry: gate("warn"), facts: facts({ quotes: 0 }) });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.requiresReason, false);
  assert.equal(verdict.mode, "warn");
  // The unmet list is what the toast names and what the audit records; a warn
  // that reported nothing would be indistinguishable from a clean move.
  assert.deepEqual(verdict.unmet.map((u) => u.field), ["quote.count"]);
});

test("reason allows the move but demands one", () => {
  const verdict = move({ entry: gate("reason"), facts: facts({ quotes: 0 }) });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.requiresReason, true);
});

test("block refuses, and does not ask for a reason it will not accept", () => {
  const verdict = move({ entry: gate("block"), facts: facts({ quotes: 0 }) });
  assert.equal(verdict.allowed, false);
  // Asking for a reason and then refusing anyway would be a dialog that cannot
  // succeed — the worst kind of prompt.
  assert.equal(verdict.requiresReason, false);
});

test("an override holder gets the reason path instead of a refusal", () => {
  const verdict = move({ entry: gate("block"), facts: facts({ quotes: 0 }), canOverride: true });
  assert.equal(verdict.allowed, true);
  // Never a silent bypass: the escape hatch is always the AUDITED one.
  assert.equal(verdict.requiresReason, true);
  assert.equal(verdict.mode, "block");
});

test("a satisfied rule is clear no matter how strict the mode", () => {
  for (const mode of ["warn", "reason", "block"] as const) {
    const verdict = move({ entry: gate(mode), facts: facts({ quotes: 2 }) });
    assert.deepEqual(verdict, CLEAR_VERDICT, `${mode} should not fire when the rule passes`);
  }
});

/* ── transition, never residency ────────────────────────────────────────── */

test("moving BACKWARD is never gated", () => {
  // Dragging a card back is a correction. Blocking a correction is how you get
  // people editing the database by hand.
  const verdict = move({
    entry: gate("block"),
    facts: facts({ quotes: 0 }),
    fromOrder: 4,
    toOrder: 2,
  });
  assert.equal(verdict.allowed, true);
});

test("reordering within the same stage is not a transition", () => {
  const verdict = evaluateStageMove({
    from: { stageId: "proposal", order: 2, exit: gate("block") },
    to: { stageId: "proposal", order: 2, entry: gate("block") },
    samePipeline: true,
    facts: facts({ quotes: 0 }),
    canOverride: false,
  });
  assert.deepEqual(verdict, CLEAR_VERDICT);
});

test("a lead already sitting in a stage is never re-judged", () => {
  // Residency is not evaluable through this function at all — there is no input
  // shape that asks "is this lead allowed to BE here". That is the property that
  // makes turning a rule on unable to strand anybody, so it is asserted as the
  // absence it is: the only same-stage question available returns CLEAR.
  const verdict = evaluateStageMove({
    from: { stageId: "proposal", order: 2, exit: gate("block") },
    to: { stageId: "proposal", order: 2, entry: gate("block") },
    samePipeline: true,
    facts: facts(),
    canOverride: false,
  });
  assert.equal(verdict.allowed, true);
});

test("a cross-pipeline move runs the target's entry gate only", () => {
  // "You may not leave Qualification without a quote" describes THIS process.
  // Moving the deal to a different process is not that transition.
  const verdict = move({
    exit: gate("block"),
    entry: gate("off", null),
    facts: facts({ quotes: 0 }),
    samePipeline: false,
  });
  assert.equal(verdict.allowed, true);
});

test("a cross-pipeline move still runs the target's entry gate", () => {
  const verdict = move({
    entry: gate("block"),
    facts: facts({ quotes: 0 }),
    samePipeline: false,
    // Deliberately a LOWER order in the target pipeline: order is not comparable
    // across pipelines, so a backward-looking number must not disable the gate.
    fromOrder: 9,
    toOrder: 1,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.direction, "entry");
});

/* ── which gate speaks ──────────────────────────────────────────────────── */

test("the exit gate is reported when both fail", () => {
  // Work not finished HERE is the more useful message than a requirement over
  // there, and only one verdict is produced so the person gets one next step.
  const verdict = move({
    exit: gate("block"),
    entry: gate("block"),
    facts: facts({ quotes: 0 }),
  });
  assert.equal(verdict.direction, "exit");
});

test("the entry gate speaks when the exit gate is satisfied", () => {
  const verdict = move({
    exit: gate("block", {
      logic: "and",
      conditions: [{ field: "contact.linked", operator: "equals", value: "true" }],
    }),
    entry: gate("block"),
    facts: facts({ contactLinked: true, quotes: 0 }),
  });
  assert.equal(verdict.direction, "entry");
});

/* ── what the rules can actually say ────────────────────────────────────── */

test("a boolean fact compares as a string, the way the editor stores it", () => {
  // The editor's Yes/No select posts "true"/"false"; the fact is a real boolean.
  // `equals` compares String(actual) === String(expected), which is what makes
  // those two agree — and it is worth an assertion, because a mismatch here
  // would make "must be linked to a contact" silently unsatisfiable.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [{ field: "contact.linked", operator: "equals", value: "true" }],
  };
  assert.equal(move({ entry: gate("block", rule), facts: facts({ contactLinked: true }) }).allowed, true);
  assert.equal(move({ entry: gate("block", rule), facts: facts({ contactLinked: false }) }).allowed, false);
});

test("several clauses are ALL required", () => {
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [
      { field: "quote.count", operator: "greater_or_equal", value: 1 },
      { field: "activity.plannedCount", operator: "greater_or_equal", value: 1 },
    ],
  };
  const verdict = move({ entry: gate("block", rule), facts: facts({ quotes: 3, planned: 0 }) });
  assert.equal(verdict.allowed, false);
  // Only the clause that failed is named. Reciting the satisfied ones back at
  // somebody is how a refusal stops being read.
  assert.deepEqual(verdict.unmet.map((u) => u.field), ["activity.plannedCount"]);
});

test("an `or` group passes on either branch", () => {
  // The editor cannot author this, the storage can hold it, and the evaluator
  // has to mean it — otherwise a hand-written rule enforces something other than
  // what it says.
  const rule: StageCriteriaGroup = {
    logic: "or",
    conditions: [
      { field: "quote.acceptedCount", operator: "greater_or_equal", value: 1 },
      { field: "signature.completedCount", operator: "greater_or_equal", value: 1 },
    ],
  };
  assert.equal(move({ entry: gate("block", rule), facts: facts({ accepted: 1 }) }).allowed, true);
  assert.equal(move({ entry: gate("block", rule), facts: facts() }).allowed, false);
});

/* ── the sentences a person reads ───────────────────────────────────────── */

test("an unmet clause is described in the vocabulary the author picked", () => {
  const [unmet] = unmetCriteria(gate("block"), facts({ quotes: 0 }));
  assert.equal(describeUnmet(unmet), "Quotes attached is at least 1");
});

test("a valueless operator does not describe a value it does not have", () => {
  const unmet = unmetCriteria(
    gate("block", { logic: "and", conditions: [{ field: "lead.email", operator: "is_not_empty" }] }),
    facts(),
  );
  assert.equal(describeUnmet(unmet[0]), "Lead email is not empty");
});

test("the refusal names the direction, so it reads as an instruction", () => {
  const entry = move({ entry: gate("block"), facts: facts({ quotes: 0 }) });
  assert.equal(refusalSentence(entry, "Proposal"), "This lead needs Quotes attached is at least 1 to enter Proposal.");

  const exit = move({ exit: gate("block"), facts: facts({ quotes: 0 }) });
  assert.equal(
    refusalSentence(exit, "Qualification"),
    "This lead needs Quotes attached is at least 1 before leaving Qualification.",
  );
});

/* ── parsing: reject at save, so evaluation never meets a surprise ──────── */

test("an unknown field is refused at parse", () => {
  // The whole reason the allow-list is closed BY NAME. At evaluation an unknown
  // path resolves to `undefined`, which fails `is_not_empty` — i.e. it would
  // block the board. Rejecting here is what keeps that unreachable.
  assert.throws(
    () => parseStageCriteria({ logic: "and", conditions: [{ field: "lead.wingspan", operator: "equals", value: 1 }] }),
    /Unsupported stage condition field: lead\.wingspan/,
  );
});

test("an operator that makes no sense for the field is refused", () => {
  assert.throws(
    () =>
      parseStageCriteria({
        logic: "and",
        conditions: [{ field: "quote.count", operator: "contains", value: "x" }],
      }),
    /cannot be used with/,
  );
});

test("a clause that needs a value and has none is refused", () => {
  assert.throws(
    () => parseStageCriteria({ logic: "and", conditions: [{ field: "quote.count", operator: "greater_or_equal" }] }),
    /needs a value/,
  );
});

test("a valueless operator stores no value", () => {
  const parsed = parseStageCriteria({
    logic: "and",
    conditions: [{ field: "lead.email", operator: "is_not_empty", value: "ignored" }],
  });
  assert.deepEqual(parsed, { logic: "and", conditions: [{ field: "lead.email", operator: "is_not_empty" }] });
});

test("more clauses than the cap are refused", () => {
  const conditions = Array.from({ length: MAX_STAGE_CRITERIA + 1 }, () => ({
    field: "quote.count",
    operator: "greater_or_equal",
    value: 1,
  }));
  assert.throws(() => parseStageCriteria({ logic: "and", conditions }), /at most/);
});

test("nesting is refused rather than silently flattened", () => {
  assert.throws(
    () =>
      parseStageCriteria({
        logic: "and",
        conditions: [{ logic: "or", conditions: [{ field: "quote.count", operator: "equals", value: 1 }] }],
      }),
    /Nested condition groups/,
  );
});

test("an empty rule parses to null, not to an empty group", () => {
  // Null and "empty group" behave identically at evaluation, but only null makes
  // `hasGate` and the editor's "no rule" state honest.
  assert.equal(parseStageCriteria({ logic: "and", conditions: [] }), null);
  assert.equal(parseStageCriteria(""), null);
  assert.equal(parseStageCriteria(null), null);
});

test("criteria arrive as a JSON string from the form and parse the same", () => {
  const parsed = parseStageCriteria(JSON.stringify(NEEDS_QUOTE));
  assert.deepEqual(parsed, NEEDS_QUOTE);
});

test("text that is not JSON is refused with a sentence, not a SyntaxError", () => {
  assert.throws(() => parseStageCriteria("{not json"), /not valid JSON/);
});

/* ── the mode parser fails OPEN, and only the mode parser ───────────────── */

test("an unreadable mode becomes off", () => {
  // The one deliberate asymmetry in this module. An unreadable RULE stops the
  // move; an unreadable SEVERITY stops enforcing. Guessing "block" on a typo
  // locks a board.
  assert.equal(parseStageGateMode("blok"), "off");
  assert.equal(parseStageGateMode(undefined), "off");
  assert.equal(parseStageGateMode(null), "off");
  assert.equal(parseStageGateMode("block"), "block");
});

/* ── the vocabulary tables stay in step ─────────────────────────────────── */

test("every field has a label, a kind, and at least one usable operator", () => {
  // Three parallel tables keyed by the same union. TypeScript enforces the keys;
  // this asserts they are not empty or placeholder, which it cannot.
  for (const field of STAGE_CRITERION_FIELDS) {
    assert.ok(STAGE_CRITERION_LABELS[field]?.length > 0, `${field} has no label`);
    assert.ok(STAGE_CRITERION_KINDS[field], `${field} has no kind`);
    assert.ok(operatorsForField(field).length > 0, `${field} offers no operators`);
  }
});

test("every field named in the allow-list resolves against a real fact snapshot", () => {
  // The guard against the failure the allow-list exists to prevent: a field that
  // is offered in the editor but dot-walks to `undefined`, producing a rule that
  // silently never passes. Two design fields were dropped for exactly this —
  // decision-maker counts and expectedCloseDate have nothing behind them.
  const snapshot = facts() as unknown as Record<string, Record<string, unknown>>;
  for (const field of STAGE_CRITERION_FIELDS) {
    const [namespace, key] = field.split(".");
    assert.ok(namespace in snapshot, `${field} has no namespace in StageGateFacts`);
    assert.ok(key in snapshot[namespace], `${field} is offered but StageGateFacts cannot supply it`);
  }
});

/* ── structural: one copy of the rules, and it is the pure one ──────────── */

test("the rules module stays importable from a client component", () => {
  // The board must be able to import this to grey a column before a drag. One
  // server-only import here — prisma, next/headers, anything transitive — makes
  // that impossible and the two sides start disagreeing about rules rather than
  // about facts.
  const text = src("src/lib/stageGate.ts");
  const imports = [...text.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/lib/journeyTypes"], "stageGate.ts must import nothing but journeyTypes");
});

test("the move action decides through evaluateStageMove rather than its own copy", () => {
  const text = src("src/app/actions/leads.ts");
  assert.ok(text.includes("evaluateStageMove("), "moveLead must call the shared evaluator");
  // A second implementation would show up as the action reading modes directly.
  assert.ok(
    !/entryGateMode\s*===\s*"block"|exitGateMode\s*===\s*"block"/.test(text),
    "the action must not re-implement mode handling",
  );
});

test("the facts loader uses the guarded client, never the RLS bypass", () => {
  // `pipelines.ts` in this same feature area is the counter-example: every
  // SalesPipeline path uses basePrisma, which is how making a pipeline default in
  // one workspace cleared it in every other one.
  // COMMENTS STRIPPED FIRST. The file explains at length why it does not use
  // `basePrisma`, and a naive scan fails on the explanation — which would have
  // taught the next person to delete the comment to make the test pass.
  const code = src("src/lib/stageGateFacts.ts")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bbasePrisma\b/.test(code), "stageGateFacts must not use basePrisma");
  assert.ok(/from "\.\/db"/.test(code) && /\bprisma\./.test(code), "stageGateFacts must use the guarded client");
});
