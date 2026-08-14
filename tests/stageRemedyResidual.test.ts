import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CLEAR_VERDICT,
  evaluateStageMove,
  type StageCriteriaGroup,
  type StageGate,
  type StageGateFacts,
  type StageGateMode,
  type StageMoveInput,
} from "../src/lib/stageGate";
import {
  STAGE_REMEDIES,
  derivedCriteria,
  factsAfterRemedy,
  offerIsPredictable,
} from "../src/lib/stageRemedies";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const shipped = (rel: string) =>
  src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A REMEDY IS JUDGED BY RE-ASKING THE RULE, NOT BY EDITING ITS ANSWER.
 *
 * The verdict is computed before the remedy runs — it has to be, because the work
 * and the move commit in one transaction and the facts cannot be re-read in
 * between. So the pre-remedy verdict still reports the very clause the remedy is
 * about to satisfy, and applied literally it refuses the move the remedy exists
 * to permit.
 *
 * The first fix for that SUBTRACTED the satisfied clause from the flattened
 * `unmet` list. That is correct only for a flat `and`: the flat list has already
 * thrown the criteria tree away, and the tree is where the rule language lives.
 * The two tests marked OR and NOT below are the ones subtraction gets wrong, in
 * both directions.
 *
 * The mechanism now is to adjust the FACTS by the remedy's declared effect and
 * call the real evaluator again on the same gates. Everything here runs the real
 * functions against real fact snapshots.
 */

function facts(
  overrides: Partial<{
    contactLinked: boolean;
    contactEmail: string | null;
    quotes: number;
    testDrives: number;
    planned: number;
    valueCents: number;
  }> = {},
): StageGateFacts {
  return {
    lead: {
      valueCents: overrides.valueCents ?? 0,
      assignedToId: null,
      productId: null,
      email: null,
      phone: null,
      source: "manual",
    },
    quote: { count: overrides.quotes ?? 0, sentCount: 0, acceptedCount: 0, latestStatus: null },
    contact: {
      linked: overrides.contactLinked ?? false,
      email: overrides.contactEmail ?? null,
      phone: null,
    },
    activity: {
      plannedCount: overrides.planned ?? 0,
      overdueCount: 0,
      testDriveCount: overrides.testDrives ?? 0,
    },
    signature: { completedCount: 0, pendingCount: 0 },
    stage: { ageDays: 0 },
  };
}

const LINK = STAGE_REMEDIES.link_contact;
const DRIVE = STAGE_REMEDIES.book_test_drive;

const LINKED: StageCriteriaGroup["conditions"][number] = {
  field: "contact.linked",
  operator: "equals",
  value: "true",
};
const HAS_QUOTE: StageCriteriaGroup["conditions"][number] = {
  field: "quote.count",
  operator: "greater_or_equal",
  value: 1,
};

function moveInput(
  mode: StageGateMode,
  criteria: StageCriteriaGroup,
  snapshot: StageGateFacts,
  canOverride = false,
): StageMoveInput {
  const entry: StageGate = { mode, criteria };
  return {
    from: { stageId: "qualification", order: 1, exit: { mode: "off", criteria: null } },
    to: { stageId: "proposal", order: 2, entry },
    samePipeline: true,
    facts: snapshot,
    canOverride,
  };
}

/** The move as it will stand once the remedy has run — what the actions now do. */
function afterRemedy(input: StageMoveInput, remedy: typeof LINK) {
  return evaluateStageMove({ ...input, facts: factsAfterRemedy(input.facts, remedy) });
}

/* ── the two the flattened list gets wrong ──────────────────────────────── */

test("OR — satisfying either branch clears the whole rule", () => {
  // THE REPORTED DEFECT. `or(a customer is linked, a quote exists)` with neither
  // true: linking the customer satisfies the RULE. Subtracting the contact clause
  // from the unmet list leaves the quote clause behind and refuses a move the
  // rule plainly permits — because a flat list cannot express "either".
  const rule: StageCriteriaGroup = { logic: "or", conditions: [LINKED, HAS_QUOTE] };
  const input = moveInput("block", rule, facts({ contactLinked: false, quotes: 0 }));

  assert.equal(evaluateStageMove(input).allowed, false, "with neither branch true, the move is refused");
  assert.deepEqual(afterRemedy(input, LINK), CLEAR_VERDICT, "linking satisfies the whole OR");
});

test("NOT — a remedy can make a rule START failing, and that must be reported", () => {
  // The other direction, and the one subtraction could never reach: removing a
  // clause can only ever LOOSEN a verdict. A stage that refuses leads which
  // already have a customer is unusual but expressible, and performing the link
  // must then be refused rather than waved through.
  const rule: StageCriteriaGroup = { logic: "not", conditions: [LINKED] };
  const input = moveInput("block", rule, facts({ contactLinked: false }));

  assert.deepEqual(evaluateStageMove(input), CLEAR_VERDICT, "unlinked, the NOT rule is satisfied");
  assert.equal(afterRemedy(input, LINK).allowed, false, "linking breaks it, and the evaluator says so");
});

/* ── the cases the first fix did get right, kept ────────────────────────── */

test("linking clears a rule that asked only for a customer", () => {
  const rule: StageCriteriaGroup = { logic: "and", conditions: [LINKED] };
  const input = moveInput("block", rule, facts({ contactLinked: false }));
  assert.equal(evaluateStageMove(input).allowed, false);
  assert.deepEqual(afterRemedy(input, LINK), CLEAR_VERDICT);
});

test("AND — a second unmet clause survives, and only it is reported", () => {
  const rule: StageCriteriaGroup = { logic: "and", conditions: [LINKED, HAS_QUOTE] };
  const input = moveInput("block", rule, facts({ contactLinked: false, quotes: 0 }));
  assert.equal(evaluateStageMove(input).unmet.length, 2);

  const verdict = afterRemedy(input, LINK);
  assert.equal(verdict.allowed, false, "the quote clause still blocks — correctly");
  assert.deepEqual(
    verdict.unmet.map((u) => u.field),
    ["quote.count"],
    "and the refusal names ONLY what is still missing, not the link being written",
  );
});

test("the override audit no longer lists the clause the same transaction satisfies", () => {
  // In reason mode the move proceeds and the audit entry is built from
  // `verdict.unmet` — which listed "a customer is linked" as unmet in the very
  // transaction that linked one.
  const rule: StageCriteriaGroup = { logic: "and", conditions: [LINKED, HAS_QUOTE] };
  const input = moveInput("reason", rule, facts({ contactLinked: false, quotes: 0 }));
  assert.ok(evaluateStageMove(input).unmet.some((u) => u.field === "contact.linked"));

  const verdict = afterRemedy(input, LINK);
  assert.equal(verdict.requiresReason, true, "a reason is still required for what remains");
  assert.ok(
    !verdict.unmet.some((u) => u.field === "contact.linked"),
    "…but the audit must not record the link as missing",
  );
});

/* ── the total failure on the test-drive path ───────────────────────────── */

test("a first test-drive booking can actually enter a book_test_drive stage", () => {
  // Found while fixing the reported case, and worse than it. A `book_test_drive`
  // stage with no explicit rules DERIVES "test drives booked ≥ 1" at block, so the
  // booking path evaluated "has a test drive" against a lead that did not have one
  // YET. Every first booking was refused — the primary remedy, and the only one
  // that existed before this branch, could never succeed.
  const input = moveInput("block", derivedCriteria(DRIVE), facts({ testDrives: 0 }));
  assert.equal(evaluateStageMove(input).allowed, false, "before the booking, the derived rule refuses");
  assert.deepEqual(afterRemedy(input, DRIVE), CLEAR_VERDICT);
});

test("a lead that already has a booking is not asked to book again", () => {
  const input = moveInput("block", derivedCriteria(DRIVE), facts({ testDrives: 1 }));
  assert.deepEqual(evaluateStageMove(input), CLEAR_VERDICT);
});

test("booking a test drive satisfies a rule that asks for any planned activity", () => {
  // The booking creates one PLANNED activity whose type is test_drive, so both
  // counters move. Declaring only the narrower counter would refuse this move for
  // a fact that is about to be true.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [{ field: "activity.plannedCount", operator: "greater_or_equal", value: 1 }],
  };
  const input = moveInput("block", rule, facts({ planned: 0 }));
  assert.equal(evaluateStageMove(input).allowed, false);
  assert.deepEqual(afterRemedy(input, DRIVE), CLEAR_VERDICT);
});

/* ── the effect declares only what it guarantees ────────────────────────── */

test("linking guarantees that a customer is attached, not which one", () => {
  // `contact.email` depends on the record the person picks, which the registry
  // cannot see — so the effect must not claim it. `moveLeadWithContact` fills it
  // in from the chosen contact, because there it IS known.
  const after = factsAfterRemedy(facts({ contactLinked: false, contactEmail: null }), LINK);
  assert.equal(after.contact.linked, true);
  assert.equal(after.contact.email, null, "the registry may not invent an email it cannot know");
});

test("the effect does not mutate the snapshot it is given", () => {
  // The same facts are evaluated twice — once as they are, once as they will be —
  // so an in-place edit would make the first answer depend on whether the second
  // had been asked.
  const before = facts({ testDrives: 0, contactLinked: false });
  factsAfterRemedy(before, DRIVE);
  factsAfterRemedy(before, LINK);
  assert.equal(before.activity.testDriveCount, 0);
  assert.equal(before.contact.linked, false);
});

/* ── mode semantics come from the evaluator, not a second copy ──────────── */

test("the re-run is judged under the same mode rules as the original", () => {
  const rule: StageCriteriaGroup = { logic: "and", conditions: [LINKED, HAS_QUOTE] };
  const snapshot = facts({ contactLinked: false, quotes: 0 });

  const outcome = (mode: StageGateMode, canOverride = false) => {
    const v = afterRemedy(moveInput(mode, rule, snapshot, canOverride), LINK);
    return { allowed: v.allowed, requiresReason: v.requiresReason };
  };

  assert.deepEqual(outcome("warn"), { allowed: true, requiresReason: false }, "warn proceeds silently");
  assert.deepEqual(outcome("reason"), { allowed: true, requiresReason: true }, "reason asks");
  assert.deepEqual(outcome("block"), { allowed: false, requiresReason: false }, "block refuses");
  assert.deepEqual(
    outcome("block", true),
    { allowed: true, requiresReason: true },
    "block + override is an audited reason, never a silent bypass",
  );
});

test("a remedy that touches nothing the rule asks about changes no verdict", () => {
  // The safety property. Performing a remedy must not be a way past a rule it has
  // nothing to do with — and because the mechanism is "re-ask the same question",
  // this holds by construction rather than by a special case.
  const rule: StageCriteriaGroup = { logic: "and", conditions: [HAS_QUOTE] };
  const input = moveInput("block", rule, facts({ quotes: 0 }));
  assert.deepEqual(afterRemedy(input, LINK), evaluateStageMove(input));
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

test("the subtraction mechanism is gone, not merely bypassed", () => {
  // It was correct for a flat AND, which is exactly why it survived a review.
  assert.doesNotMatch(shipped("src/lib/stageGate.ts"), /export function verdictAfterRemedy/);
  assert.doesNotMatch(shipped("src/app/actions/leads.ts"), /verdictAfterRemedy\(/);
  assert.doesNotMatch(shipped("src/app/actions/leads.ts"), /onlyTheLink/);
});

test("both remedy actions re-run the evaluator on their own post-remedy facts", () => {
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
    assert.match(body, /evaluateStageMove\(\{/, `${fn} must re-run the evaluator`);
    assert.match(
      body,
      new RegExp(`factsAfterRemedy\\(gated\\.move\\.facts, STAGE_REMEDIES\\.${remedy}\\)`),
      `${fn} must adjust the facts by ${remedy}'s declared effect, taken from the registry`,
    );
  }
});

test("the offer is decided by asking the real evaluator, not by inspecting a flag", () => {
  // The offer must be a rule question — "would doing this get the lead in?" —
  // rather than "does this stage name a remedy?", which is what the board used to
  // decide for itself.
  //
  // WHETHER it may ask at all was itself a defect, twice, and is pinned separately
  // below: a remedy whose outcome depends on a choice cannot be predicted, so it
  // is not predicted.
  const code = shipped("src/app/actions/leads.ts");
  const start = code.indexOf("async function gateStageMove");
  const body = code.slice(start, code.indexOf("\nconst BROKEN_RULE_MESSAGE", start));
  assert.match(body, /evaluateStageMove\(\{ \.\.\.move, facts: factsAfterRemedy\(move\.facts, remedy\) \}\)\.allowed/);
  assert.match(body, /!offerIsPredictable\(remedy\) \|\|/, "…and only when prediction is possible");
  assert.match(body, /remedy: worthOffering \? remedy : null/);
});

test("the chosen customer's own details are used, since that call site knows them", () => {
  const code = shipped("src/app/actions/leads.ts");
  const start = code.indexOf("function moveLeadWithContactInScope");
  const body = code.slice(start, code.indexOf("\nexport ", start + 1));
  assert.match(body, /contact: \{ \.\.\.base\.contact, email: contact\.email, phone: contact\.phone \}/);
  // …which means they have to be selected, or they would silently be undefined.
  assert.match(body, /email: true,\s*\n\s*phone: true,/);
});

/* ── the offer asks a different question from the action ────────────────── */

test("OFFER — a rule wanting a customer AND their email still opens the picker", () => {
  // THE REPORTED DEFECT. `effect` is what the remedy GUARANTEES whatever is
  // chosen — for link_contact, only that a customer is attached. Deciding the
  // OFFER with it refused `and(linked, email is not empty)` outright and never
  // opened the picker, even though choosing a customer who has an email satisfies
  // both. The action already projected the chosen contact's real email; that code
  // was simply unreachable.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [LINKED, { field: "contact.email", operator: "is_not_empty", value: "" }],
  };
  const input = moveInput("block", rule, facts({ contactLinked: false, contactEmail: null }));
  assert.equal(evaluateStageMove(input).allowed, false, "unlinked, it refuses");

  // The guarantee alone cannot promise an email, which is why predicting the
  // offer from it suppressed the picker.
  const guaranteed = evaluateStageMove({ ...input, facts: factsAfterRemedy(input.facts, LINK) });
  assert.equal(guaranteed.allowed, false);

  // So this remedy is not predicted at all. The picker opens whenever it
  // addresses something unmet, and the action judges what was picked.
  assert.equal(offerIsPredictable(LINK), false, "its outcome depends on which customer is chosen");
});

test("no rule about real values can be suppressed by an invented one", () => {
  // THE SECOND REPORTED DEFECT, and why guessing was abandoned rather than
  // improved. Sentinel values fixed `email is not empty` and still suppressed a
  // rule about the address itself — an invented address cannot satisfy a rule
  // about real ones, and every sentinel has that shape for some rule.
  //
  // The report named `ends_with`, which this operator set does not have; the
  // defect is the same with `contains`, which it does. That is the point — the
  // failure belongs to the whole class of value rules, not to one operator.
  //
  // The property is now structural: the offer for a choice-dependent remedy does
  // not evaluate anything, so there is no value for a rule to disagree with.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [LINKED, { field: "contact.email", operator: "contains", value: ".co.za" }],
  };
  const input = moveInput("block", rule, facts({ contactLinked: false, contactEmail: null }));
  assert.equal(evaluateStageMove(input).allowed, false, "unlinked, it refuses");
  assert.equal(offerIsPredictable(LINK), false, "…and the picker opens regardless of the operator");

  // …and a customer whose address DOES match clears it, which is the outcome the
  // suppressed picker was preventing anyone from reaching.
  const base = factsAfterRemedy(input.facts, LINK);
  const chosen = { ...base, contact: { ...base.contact, email: "buyer@acme.co.za" } };
  assert.deepEqual(evaluateStageMove({ ...input, facts: chosen }), CLEAR_VERDICT);
});

test("ACTION — opening the picker permits nothing", () => {
  // The safety property. The action re-judges against the contact actually
  // chosen, so picking one WITHOUT an email is still refused, naming what is
  // missing. That refusal is the cost of not guessing, and it is the right cost:
  // a dialog that sometimes ends in a refusal beats a rule nobody can satisfy.
  const rule: StageCriteriaGroup = {
    logic: "and",
    conditions: [LINKED, { field: "contact.email", operator: "is_not_empty", value: "" }],
  };
  const input = moveInput("block", rule, facts({ contactLinked: false, contactEmail: null }));

  // The action's projection: the registry baseline, then the chosen contact's own
  // values — exactly what moveLeadWithContact builds.
  const base = factsAfterRemedy(input.facts, LINK);
  const chosenWithout = { ...base, contact: { ...base.contact, email: null, phone: null } };
  assert.equal(
    evaluateStageMove({ ...input, facts: chosenWithout }).allowed,
    false,
    "a customer with no email must still be refused",
  );

  const chosenWith = { ...base, contact: { ...base.contact, email: "real@customer.com", phone: null } };
  assert.deepEqual(
    evaluateStageMove({ ...input, facts: chosenWith }),
    CLEAR_VERDICT,
    "…and one with an email goes through",
  );
});

test("a remedy that collects nothing IS still predicted", () => {
  // The suppression is worth keeping where it is sound. Booking a test drive
  // creates exactly one planned test drive whatever anyone does, so the server can
  // say in advance whether it would get the lead in — and refuse once, naming
  // everything missing, rather than opening a dialog that leads to the same
  // refusal with the booking thrown away.
  assert.equal(offerIsPredictable(DRIVE), true);

  const rule: StageCriteriaGroup = { logic: "and", conditions: [HAS_QUOTE] };
  const input = moveInput("block", rule, facts({ testDrives: 0, quotes: 0 }));
  assert.equal(
    evaluateStageMove({ ...input, facts: factsAfterRemedy(input.facts, DRIVE) }).allowed,
    false,
    "booking would not satisfy a quote rule, so the dialog is not worth opening",
  );
});

test("no invented value survives anywhere in the registry", () => {
  // The mechanism that produced the second defect is gone, not merely unused. A
  // sentinel reintroduced for any future remedy would fail a rule about real
  // values in exactly the same way.
  const code = shipped("src/lib/stageRemedies.ts");
  assert.doesNotMatch(code, /BEST_CASE_EMAIL|BEST_CASE_PHONE|offerEffect/);
  assert.doesNotMatch(code, /@example\.com/, "no stand-in address may reach a decision");
});
