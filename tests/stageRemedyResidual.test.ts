import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLEAR_VERDICT,
  evaluateStageMove,
  verdictAfterRemedy,
  type StageCriteriaGroup,
  type StageGate,
  type StageGateFacts,
  type StageGateMode,
} from "../src/lib/stageGate";
import { STAGE_REMEDIES, derivedCriteria } from "../src/lib/stageRemedies";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A REMEDY CANNOT BE JUDGED BY THE VERDICT THAT SUMMONED IT.
 *
 * The verdict is computed before the remedy runs — it has to be, because the work
 * and the move commit in one transaction and the facts cannot be re-read in
 * between. So the pre-remedy verdict still reports the very clause the remedy is
 * about to satisfy, and applied literally it refuses the move the remedy exists
 * to permit.
 *
 * Two paths did exactly that, and neither was caught by the source-shape tests
 * around them, because the shape was right and only the arithmetic was wrong.
 * Everything below runs the real functions against real fact snapshots.
 */

function facts(overrides: Partial<{ contactLinked: boolean; testDrives: number; valueCents: number }> = {}): StageGateFacts {
  return {
    lead: {
      valueCents: overrides.valueCents ?? 0,
      assignedToId: null,
      productId: null,
      email: null,
      phone: null,
      source: "manual",
    },
    quote: { count: 0, sentCount: 0, acceptedCount: 0, latestStatus: null },
    contact: { linked: overrides.contactLinked ?? false, email: null, phone: null },
    activity: { plannedCount: 0, overdueCount: 0, testDriveCount: overrides.testDrives ?? 0 },
    signature: { completedCount: 0, pendingCount: 0 },
    stage: { ageDays: 0 },
  };
}

const LINK_FIELD = STAGE_REMEDIES.link_contact.satisfies.field;
const DRIVE_FIELD = STAGE_REMEDIES.book_test_drive.satisfies.field;

/** "a customer must be linked AND the deal must be worth R10 000" — two clauses, one remedy. */
const LINK_AND_VALUE: StageCriteriaGroup = {
  logic: "and",
  conditions: [
    { field: LINK_FIELD, operator: "equals", value: "true" },
    { field: "lead.valueCents", operator: "greater_or_equal", value: 1_000_000 },
  ],
};

function verdictFor(mode: StageGateMode, criteria: StageCriteriaGroup, snapshot: StageGateFacts, canOverride = false) {
  const entry: StageGate = { mode, criteria };
  return evaluateStageMove({
    from: { stageId: "qualification", order: 1, exit: { mode: "off", criteria: null } },
    to: { stageId: "proposal", order: 2, entry },
    samePipeline: true,
    facts: snapshot,
    canOverride,
  });
}

/* ── the reported defect ────────────────────────────────────────────────── */

test("linking the customer clears a rule that asked only for a customer", () => {
  const only: StageCriteriaGroup = {
    logic: "and",
    conditions: [{ field: LINK_FIELD, operator: "equals", value: "true" }],
  };
  const verdict = verdictFor("block", only, facts({ contactLinked: false }));
  assert.equal(verdict.allowed, false, "unlinked, the move is refused");

  const residual = verdictAfterRemedy(verdict, LINK_FIELD, false);
  assert.deepEqual(residual, CLEAR_VERDICT, "once the link is counted, nothing objects");
});

test("a second unmet clause survives the remedy, and only it is reported", () => {
  // THE REPORTED DEFECT. Missing a link AND a value, the old guard ("proceed only
  // when the link is the ONLY thing unmet") failed, the pre-link verdict was
  // applied whole, and the move was refused after the customer had been chosen —
  // so the offered remedy accomplished nothing.
  const verdict = verdictFor("block", LINK_AND_VALUE, facts({ contactLinked: false, valueCents: 0 }));
  assert.equal(verdict.unmet.length, 2);

  const residual = verdictAfterRemedy(verdict, LINK_FIELD, false);
  assert.equal(residual.allowed, false, "the value clause still blocks — correctly");
  assert.deepEqual(
    residual.unmet.map((u) => u.field),
    ["lead.valueCents"],
    "and the refusal names ONLY what is still missing, not the link being written",
  );
});

test("the override audit no longer lists the clause the same transaction satisfies", () => {
  // The second half of the report. In reason mode the move proceeds, and the
  // audit entry is built from `verdict.unmet` — which listed "a customer is
  // linked" as unmet in the very transaction that linked one.
  const verdict = verdictFor("reason", LINK_AND_VALUE, facts({ contactLinked: false, valueCents: 0 }));
  assert.ok(verdict.unmet.some((u) => u.field === LINK_FIELD), "the pre-link verdict does list it");

  const residual = verdictAfterRemedy(verdict, LINK_FIELD, false);
  assert.equal(residual.requiresReason, true, "a reason is still required for what remains");
  assert.ok(
    !residual.unmet.some((u) => u.field === LINK_FIELD),
    "…but the audit must not record the link as missing",
  );
});

/* ── the total failure on the test-drive path ───────────────────────────── */

test("a first test-drive booking can actually enter a book_test_drive stage", () => {
  // WORSE THAN THE REPORTED CASE, and found while fixing it. A `book_test_drive`
  // stage with no explicit rules DERIVES "test drives booked ≥ 1" at block, so the
  // booking path evaluated "has a test drive" against a lead that did not have one
  // YET. Every first booking was refused — the primary remedy, and the only one
  // that existed before this branch, could never succeed.
  const derived = derivedCriteria(STAGE_REMEDIES.book_test_drive);
  const verdict = verdictFor("block", derived, facts({ testDrives: 0 }));
  assert.equal(verdict.allowed, false, "before the booking, the derived rule refuses");

  const residual = verdictAfterRemedy(verdict, DRIVE_FIELD, false);
  assert.deepEqual(residual, CLEAR_VERDICT, "the booking about to be written is what satisfies it");
});

test("a lead that already has a booking is not asked to book again", () => {
  // The behaviour the derivation was introduced for, unchanged by this fix.
  const derived = derivedCriteria(STAGE_REMEDIES.book_test_drive);
  assert.deepEqual(verdictFor("block", derived, facts({ testDrives: 1 })), CLEAR_VERDICT);
});

/* ── mode semantics are preserved, not re-invented ──────────────────────── */

test("the residual is judged under the same mode rules as the original", () => {
  const snapshot = facts({ contactLinked: false, valueCents: 0 });

  const warn = verdictAfterRemedy(verdictFor("warn", LINK_AND_VALUE, snapshot), LINK_FIELD, false);
  assert.deepEqual(
    { allowed: warn.allowed, requiresReason: warn.requiresReason },
    { allowed: true, requiresReason: false },
    "warn proceeds and asks for nothing",
  );

  const reason = verdictAfterRemedy(verdictFor("reason", LINK_AND_VALUE, snapshot), LINK_FIELD, false);
  assert.deepEqual(
    { allowed: reason.allowed, requiresReason: reason.requiresReason },
    { allowed: true, requiresReason: true },
    "reason proceeds and asks",
  );

  const blocked = verdictAfterRemedy(verdictFor("block", LINK_AND_VALUE, snapshot), LINK_FIELD, false);
  assert.deepEqual(
    { allowed: blocked.allowed, requiresReason: blocked.requiresReason },
    { allowed: false, requiresReason: false },
    "block refuses",
  );

  // …and an override holder gets the audited escape hatch rather than a refusal,
  // exactly as evaluateStageMove gives them. This is why canOverride is passed in
  // rather than inferred: the residual has to make the same choice the original
  // made, with the same input.
  const override = verdictAfterRemedy(
    verdictFor("block", LINK_AND_VALUE, snapshot, true),
    LINK_FIELD,
    true,
  );
  assert.deepEqual(
    { allowed: override.allowed, requiresReason: override.requiresReason },
    { allowed: true, requiresReason: true },
    "block + override is a reason, never a silent bypass",
  );
});

test("direction and mode ride through, so the sentence still reads correctly", () => {
  const verdict = verdictFor("block", LINK_AND_VALUE, facts({ contactLinked: false }));
  const residual = verdictAfterRemedy(verdict, LINK_FIELD, false);
  assert.equal(residual.direction, verdict.direction);
  assert.equal(residual.mode, verdict.mode);
});

/* ── it cannot be used to launder an unrelated refusal ──────────────────── */

test("a remedy that addresses nothing leaves the verdict exactly as it was", () => {
  // The safety property. `verdictAfterRemedy` weakens a verdict, so a caller
  // passing a field that has nothing to do with what failed must get no discount
  // at all — otherwise "perform some remedy, any remedy" becomes a way past a
  // rule it never touched.
  const verdict = verdictFor("block", LINK_AND_VALUE, facts({ contactLinked: false, valueCents: 0 }));
  const residual = verdictAfterRemedy(verdict, "quote.count", false);
  assert.deepEqual(residual, verdict, "returned untouched, not rebuilt");
});

test("an already-clear verdict is unaffected", () => {
  assert.deepEqual(verdictAfterRemedy(CLEAR_VERDICT, LINK_FIELD, false), CLEAR_VERDICT);
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test("both remedy actions discount their own work before judging", () => {
  const code = shipped("src/app/actions/leads.ts");
  for (const [fn, remedy] of [
    ["moveLeadWithContact", "link_contact"],
    ["moveLeadToTestDrive", "book_test_drive"],
  ] as const) {
    const start = code.indexOf(`function ${fn}`);
    assert.ok(start >= 0, `${fn} must exist`);
    const end = code.indexOf("\nexport ", start + 1);
    assert.ok(end > start, `${fn} must be followed by another export for this slice to be bounded`);
    const body = code.slice(start, end);
    assert.match(
      body,
      new RegExp(`verdictAfterRemedy\\(\\s*gated\\.verdict,\\s*STAGE_REMEDIES\\.${remedy}\\.satisfies\\.field`),
      `${fn} must discount ${remedy}'s own field, and take it from the registry`,
    );
  }

  // The old narrow guard is gone, not merely bypassed. It was correct for a stage
  // with one rule, which is why it survived review.
  assert.doesNotMatch(code, /onlyTheLink/, "the one-rule-only guard is what this replaced");
});

test("a remedy is only offered when performing it would complete the move", () => {
  // Otherwise the dialog is a detour to the same refusal: the remedy action
  // refuses before writing anything, so the customer chosen or the test drive
  // booked is thrown away. Refuse once, naming everything missing.
  const code = shipped("src/app/actions/leads.ts");
  const start = code.indexOf("async function gateStageMove");
  const body = code.slice(start, code.indexOf("\nconst BROKEN_RULE_MESSAGE", start));
  assert.match(body, /verdictAfterRemedy\(verdict, remedy\.satisfies\.field, canOverride\)\.allowed/);
  assert.match(body, /remedy: worthOffering \? remedy : null/);
});
