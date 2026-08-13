/**
 * Stage entry and exit criteria — the rules half.
 *
 * PURE. The only import is type-and-function from `journeyTypes`, which itself
 * has ZERO imports, so this module is safe to import from `KanbanBoard.tsx`. That
 * is not a stylistic preference: the board and `moveLead` must reach the SAME
 * decision function, because the entire design rests on them being unable to
 * disagree about rules. They may disagree about FACTS — the board's are a render
 * snapshot, the server's are re-derived per move — and only the server's count.
 *
 * ── THE ONE RULE THAT STOPS CARDS BEING STRANDED ────────────────────────────
 *
 * GATES EVALUATE ON TRANSITION, NEVER ON RESIDENCY. A lead already sitting in
 * Proposal is never re-checked, never badged illegal, never blocked from staying.
 * A gate is a function of a MOVE, not of a STATE. That single sentence is the
 * whole compatibility story: turning a rule on cannot invalidate a board, and
 * editing one cannot trap a deal that is already there.
 *
 * Corollaries, each a deliberate decision rather than an omission:
 *
 *   - Gates fire FORWARD ONLY (target order > current order). Dragging a card
 *     back is a correction, and blocking a correction is how you end up with
 *     people editing the database by hand.
 *   - Closing a deal is always allowed. `markWon`/`markLost` never call this.
 *     A dead deal that cannot be marked lost is the worst possible outcome of
 *     the whole feature.
 *   - A CROSS-PIPELINE move runs the target's ENTRY gate only. "You may not
 *     leave Qualification without X" is a statement about *this* process; moving
 *     the deal to a different process is not the transition its author described.
 *   - A NULL gate is structurally incapable of blocking: `evaluateConditions`
 *     returns true for a null or empty group, and every stage ships `off`.
 */
import {
  evaluateConditions,
  explainConditions,
  type ConditionOperator,
  type JourneyConditionGroup,
} from "@/lib/journeyTypes";

/**
 * The STORAGE shape: structurally the journey builder's condition group, with
 * this feature's field vocabulary substituted.
 *
 * Not `JourneyConditionGroup` itself, because that type's `field` is the
 * journey's own closed union — `quote.count` is not a member of it and never
 * should be. The two are structurally identical everywhere it matters, which is
 * why {@link asEvaluable} below is a cast and not a conversion: the evaluator
 * only ever DOT-WALKS `field` through `valueAtPath`, it never interprets it, so
 * feeding it a different vocabulary is exactly as safe as feeding it its own.
 */
export type StageCriterion = {
  field: StageCriterionField;
  operator: ConditionOperator;
  value?: unknown;
};

export type StageCriteriaGroup = {
  logic: "and" | "or" | "not";
  conditions: StageCriterion[];
};

/** The one place the vocabularies are bridged. See {@link StageCriteriaGroup}. */
function asEvaluable(group: StageCriteriaGroup): JourneyConditionGroup {
  return group as unknown as JourneyConditionGroup;
}

/**
 * The comparison vocabulary is borrowed WHOLESALE from the journey builder,
 * exactly as `dashboard/conditions.ts` borrows it and for the same stated
 * reason: someone who has learned "is / is not / is at least / is empty"
 * building an automation must not meet a second, subtly different set here.
 *
 * Typed as `ConditionOperator[]` rather than restated as a fresh union, so
 * removing an operator upstream is a compile error here instead of a runtime
 * surprise. A SUBSET is intended — `contains` on a count means nothing — and a
 * subset is what the field-type table below actually offers.
 */
export const STAGE_GATE_OPERATORS: readonly ConditionOperator[] = [
  "equals",
  "not_equals",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "contains",
  "not_contains",
  "in",
  "is_empty",
  "is_not_empty",
];

export const STAGE_GATE_MODES = ["off", "warn", "reason", "block"] as const;
export type StageGateMode = (typeof STAGE_GATE_MODES)[number];

/**
 * What each mode does. Rendered in the settings picker, so the wording here is
 * the wording the person authoring the rule reads.
 */
export const STAGE_GATE_MODE_LABELS: Record<StageGateMode, string> = {
  off: "Off — show as a hint only",
  warn: "Warn — allow the move, name what is missing",
  reason: "Ask for a reason before allowing it",
  block: "Block the move",
};

/**
 * Closed allow-list of dot-paths into {@link StageGateFacts}.
 *
 * Closed by NAME, not by namespace. A criterion naming a field that no longer
 * exists has to be a save-time error, because at evaluation time an unresolvable
 * path is `undefined`, and `undefined` under `is_not_empty` FAILS the clause —
 * which for a gate means blocking the board. Rejecting at parse is what keeps
 * that path near-unreachable; see {@link parseStageCriteria}.
 *
 * TWO FIELDS FROM THE DESIGN ARE ABSENT, because the data behind them is not
 * there to read. Naming them and resolving `undefined` would have produced a
 * rule that silently never passes — the exact failure the closed list exists to
 * prevent — so they are omitted until something backs them:
 *
 *   - `contact.decisionMakerCount`. There is NO decision-maker concept anywhere
 *     in the schema: no flag on Contact, no role on a lead-contact link. It was
 *     the design's flagship example ("a lead cannot enter Proposal without a
 *     decision-maker"), and it needs a modelling decision of its own first.
 *   - `lead.expectedCloseDate`. The column exists in Postgres (migration 52) but
 *     was never declared on the Prisma model, alongside `teamId`, `probability`
 *     and `forecastCategory` — the same drift class that PR #466 fixed for
 *     PipelineStage. Declaring one of the four here would mix a forecasting
 *     schema repair into a gates change; that repair deserves its own PR, and
 *     this list can grow the day it lands.
 */
export const STAGE_CRITERION_FIELDS = [
  "lead.valueCents",
  "lead.assignedToId",
  "lead.productId",
  "lead.email",
  "lead.phone",
  "lead.source",
  "quote.count",
  "quote.sentCount",
  "quote.acceptedCount",
  "quote.latestStatus",
  "contact.linked",
  "contact.email",
  "contact.phone",
  "activity.plannedCount",
  "activity.overdueCount",
  "signature.completedCount",
  "signature.pendingCount",
  "stage.ageDays",
] as const;
export type StageCriterionField = (typeof STAGE_CRITERION_FIELDS)[number];

/**
 * Labels live BESIDE the list, in one place. Two copies of a label list drift;
 * `journeyTypes` says so in as many words, and `marketingAudiences` is the local
 * proof — its client re-declares the field list by hand.
 */
export const STAGE_CRITERION_LABELS: Record<StageCriterionField, string> = {
  "lead.valueCents": "Deal value (cents)",
  "lead.assignedToId": "Assigned owner",
  "lead.productId": "Model / product",
  "lead.email": "Lead email",
  "lead.phone": "Lead phone",
  "lead.source": "Lead source",
  "quote.count": "Quotes attached",
  "quote.sentCount": "Quotes sent",
  "quote.acceptedCount": "Quotes accepted",
  "quote.latestStatus": "Latest quote status",
  "contact.linked": "Linked to a contact",
  "contact.email": "Contact email",
  "contact.phone": "Contact phone",
  "activity.plannedCount": "Planned activities",
  "activity.overdueCount": "Overdue activities",
  "signature.completedCount": "Completed signatures",
  "signature.pendingCount": "Pending signatures",
  "stage.ageDays": "Days in current stage",
};

/** Which operators make sense for a field, so the editor cannot offer nonsense. */
export type StageCriterionKind = "number" | "text" | "boolean" | "date";

export const STAGE_CRITERION_KINDS: Record<StageCriterionField, StageCriterionKind> = {
  "lead.valueCents": "number",
  "lead.assignedToId": "text",
  "lead.productId": "text",
  "lead.email": "text",
  "lead.phone": "text",
  "lead.source": "text",
  "quote.count": "number",
  "quote.sentCount": "number",
  "quote.acceptedCount": "number",
  "quote.latestStatus": "text",
  "contact.linked": "boolean",
  "contact.email": "text",
  "contact.phone": "text",
  "activity.plannedCount": "number",
  "activity.overdueCount": "number",
  "signature.completedCount": "number",
  "signature.pendingCount": "number",
  "stage.ageDays": "number",
};

const OPERATORS_BY_KIND: Record<StageCriterionKind, readonly ConditionOperator[]> = {
  number: ["greater_or_equal", "greater_than", "less_or_equal", "less_than", "equals", "not_equals"],
  text: ["is_not_empty", "is_empty", "equals", "not_equals", "contains", "not_contains", "in"],
  boolean: ["equals", "not_equals"],
  date: ["is_not_empty", "is_empty", "greater_than", "less_than"],
};

export function operatorsForField(field: StageCriterionField): readonly ConditionOperator[] {
  return OPERATORS_BY_KIND[STAGE_CRITERION_KINDS[field]];
}

/** Human wording for an operator, matching the journey builder's phrasing. */
export const STAGE_OPERATOR_LABELS: Record<ConditionOperator, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  greater_than: "is more than",
  greater_or_equal: "is at least",
  less_than: "is less than",
  less_or_equal: "is at most",
  in: "is one of",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

/** Operators that take no value, so the editor hides the input and the parser drops it. */
const VALUELESS: ReadonlySet<ConditionOperator> = new Set(["is_empty", "is_not_empty"]);

/**
 * How many clauses one gate may hold.
 *
 * Five, not the journey builder's thirty. A journey is a program and can earn
 * thirty conditions; a GATE has to be readable inside a one-line refusal, and a
 * thirty-clause rule that blocks a board is a support call, not a feature.
 */
export const MAX_STAGE_CRITERIA = 5;

/**
 * What the evaluator reads. Flat, JSON-safe, and IDENTICAL on both sides.
 *
 * Derived facts, not lead columns, are the whole point: "has a quote attached"
 * and "has a decision-maker" are the criteria people actually want, and neither
 * is a column on Lead. This is the same seam journeys already use — an impure
 * builder (`stageGateFacts.ts`, which imports prisma) hands a plain record to a
 * pure evaluator (this file, which imports nothing that touches a database).
 */
export type StageGateFacts = {
  lead: {
    valueCents: number;
    assignedToId: string | null;
    productId: string | null;
    email: string | null;
    phone: string | null;
    source: string;
  };
  quote: { count: number; sentCount: number; acceptedCount: number; latestStatus: string | null };
  contact: { linked: boolean; email: string | null; phone: string | null };
  activity: { plannedCount: number; overdueCount: number };
  signature: { completedCount: number; pendingCount: number };
  stage: { ageDays: number };
};

export type StageGate = {
  mode: StageGateMode;
  criteria: StageCriteriaGroup | null;
};

export type UnmetCriterion = {
  field: string;
  operator: ConditionOperator;
  expected: unknown;
  actual: unknown;
};

export type StageGateVerdict = {
  /** May the move proceed at all? */
  allowed: boolean;
  /** Must the caller supply a typed override reason for it to proceed? */
  requiresReason: boolean;
  /** Which gate produced the verdict — "leave Qualification" reads differently to "enter Proposal". */
  direction: "entry" | "exit" | null;
  mode: StageGateMode;
  unmet: UnmetCriterion[];
};

/** The verdict for a move nothing objects to. Shared so callers cannot spell it differently. */
export const CLEAR_VERDICT: StageGateVerdict = {
  allowed: true,
  requiresReason: false,
  direction: null,
  mode: "off",
  unmet: [],
};

/**
 * Which clauses of one gate are not satisfied by these facts.
 *
 * `explainConditions` already walks the tree and reports `passed` per leaf, so
 * this is a filter rather than a second evaluator — a second evaluator is
 * precisely how a UI ends up disagreeing with the rule it is describing.
 *
 * NEGATED leaves (inside a `not` group) are reported when they DID pass, because
 * inside a NOR group a passing clause is the reason the group failed.
 */
export function unmetCriteria(
  gate: StageGate,
  facts: StageGateFacts,
): UnmetCriterion[] {
  if (!gate.criteria) return [];
  return explainConditions(asEvaluable(gate.criteria), facts as unknown as Record<string, unknown>)
    .filter((leaf) => (leaf.negated ? leaf.passed : !leaf.passed))
    .map((leaf) => ({
      field: leaf.field,
      // `ConditionExplanation.operator` is widened to `string` for the journey
      // builder's own display code. Every leaf here came through
      // `parseStageCriteria`, which rejects anything outside the operator set.
      operator: leaf.operator as ConditionOperator,
      expected: leaf.expected,
      actual: leaf.actual,
    }));
}

/**
 * THE decision for one move.
 *
 * Both gates are considered, and the EXIT gate is checked first: leaving a stage
 * without meeting its exit rule is a statement about work not finished here,
 * which is the more useful message when both fail. Only one verdict is produced
 * either way — a person fixing a move wants the next thing to do, not a list.
 */
export function evaluateStageMove(input: {
  from: { stageId: string; order: number; exit: StageGate } | null;
  to: { stageId: string; order: number; entry: StageGate };
  samePipeline: boolean;
  facts: StageGateFacts;
  canOverride: boolean;
}): StageGateVerdict {
  const { from, to, samePipeline, facts, canOverride } = input;

  // Not a transition at all. Reordering inside a column is not a stage change,
  // and re-evaluating it would be residency checking by the back door.
  if (from && from.stageId === to.stageId) return CLEAR_VERDICT;

  // BACKWARD moves are corrections and are never gated. Order is only comparable
  // inside one pipeline; across pipelines there is no "back".
  if (samePipeline && from && to.order <= from.order) return CLEAR_VERDICT;

  const gates: Array<{ direction: "entry" | "exit"; gate: StageGate }> = [];
  // Cross-pipeline moves run the TARGET's entry gate only — see the header.
  if (samePipeline && from) gates.push({ direction: "exit", gate: from.exit });
  gates.push({ direction: "entry", gate: to.entry });

  for (const { direction, gate } of gates) {
    if (gate.mode === "off") continue;
    if (!gate.criteria || gate.criteria.conditions.length === 0) continue;
    if (evaluateConditions(asEvaluable(gate.criteria), facts as unknown as Record<string, unknown>)) continue;

    const unmet = unmetCriteria(gate, facts);
    if (gate.mode === "warn") {
      // Proceeds. The caller names the unmet clauses in a toast and audits them.
      return { allowed: true, requiresReason: false, direction, mode: "warn", unmet };
    }
    if (gate.mode === "reason") {
      return { allowed: true, requiresReason: true, direction, mode: "reason", unmet };
    }
    // block — an override holder gets the `reason` path rather than a refusal,
    // so the escape hatch is always an AUDITED one rather than a silent bypass.
    return canOverride
      ? { allowed: true, requiresReason: true, direction, mode: "block", unmet }
      : { allowed: false, requiresReason: false, direction, mode: "block", unmet };
  }

  return CLEAR_VERDICT;
}

/**
 * One sentence for one failed clause. Used by the drag tooltip AND the server's
 * refusal, so the wording a person is refused with is the wording they were
 * warned with.
 */
export function describeUnmet(unmet: UnmetCriterion): string {
  const label =
    STAGE_CRITERION_LABELS[unmet.field as StageCriterionField] ?? unmet.field;
  const operator = STAGE_OPERATOR_LABELS[unmet.operator] ?? unmet.operator;
  if (VALUELESS.has(unmet.operator)) return `${label} ${operator}`;
  const expected = Array.isArray(unmet.expected)
    ? unmet.expected.join(", ")
    : String(unmet.expected ?? "");
  return `${label} ${operator} ${expected}`.trim();
}

/** The refusal a person reads. Names the direction, then what is missing. */
export function refusalSentence(verdict: StageGateVerdict, stageName: string): string {
  const what = verdict.unmet.map(describeUnmet).join("; ");
  const where =
    verdict.direction === "exit"
      ? `before leaving ${stageName}`
      : `to enter ${stageName}`;
  return what ? `This lead needs ${what} ${where}.` : `This lead does not meet the rules ${where}.`;
}

/**
 * Save-time validator. Throws with a human message, in the shape of
 * `parseConditionGroup`, which is what `asActionResult` turns into a toast.
 *
 * Deliberately NOT a wrapper around `parseConditionGroup`: that one validates
 * against the JOURNEY field list, so every stage field would be rejected by it
 * before this module saw them. The structure rules are re-stated rather than
 * borrowed, and the operator set is imported so the two cannot drift.
 */
export function parseStageCriteria(value: unknown): StageCriteriaGroup | null {
  if (value == null || value === "") return null;
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (raw == null) return null;
  if (!isRecord(raw)) throw new Error("Stage criteria must be an object");

  const logic = raw.logic === "or" ? "or" : raw.logic === "not" ? "not" : "and";
  if (!Array.isArray(raw.conditions)) throw new Error("Stage criteria must contain a list of conditions");
  if (raw.conditions.length > MAX_STAGE_CRITERIA) {
    throw new Error(`A stage rule may contain at most ${MAX_STAGE_CRITERIA} conditions`);
  }
  if (raw.conditions.length === 0) return null;

  const operators = new Set<string>(STAGE_GATE_OPERATORS);
  const fields = new Set<string>(STAGE_CRITERION_FIELDS);
  const conditions = raw.conditions.map((condition) => {
    if (!isRecord(condition)) throw new Error("Invalid stage condition");
    if (Array.isArray(condition.conditions)) {
      // Nesting is storable and evaluable, but nothing authors it yet. Refusing
      // it here keeps the editor and the storage honest with each other; §1.6's
      // read-only fallback covers a group that arrives some other way.
      throw new Error("Nested condition groups are not supported in a stage rule");
    }
    const field = String(condition.field ?? "");
    const operator = String(condition.operator ?? "");
    if (!fields.has(field)) throw new Error(`Unsupported stage condition field: ${field}`);
    if (!operators.has(operator)) throw new Error(`Unsupported stage condition operator: ${operator}`);
    const typed = operator as ConditionOperator;
    if (!operatorsForField(field as StageCriterionField).includes(typed)) {
      throw new Error(
        `“${STAGE_OPERATOR_LABELS[typed]}” cannot be used with “${STAGE_CRITERION_LABELS[field as StageCriterionField]}”`,
      );
    }
    // A valueless operator carries no value: storing one would show up in the
    // editor next release as a value the rule does not actually use.
    const typedField = field as StageCriterionField;
    if (VALUELESS.has(typed)) return { field: typedField, operator: typed };
    if (condition.value == null || condition.value === "") {
      throw new Error(`“${STAGE_CRITERION_LABELS[typedField]}” needs a value`);
    }
    return { field: typedField, operator: typed, value: condition.value };
  });

  return { logic, conditions };
}

/**
 * Mode parser. An unknown value becomes "off".
 *
 * Fail-OPEN here, unlike everywhere else in this file, and the asymmetry is
 * deliberate: an unreadable MODE must never become a block. A stored criteria
 * document that cannot be understood should stop the move; a stored severity
 * that cannot be understood should stop enforcing. One is "we do not know if
 * this deal qualifies", the other is "we do not know how strict to be", and
 * guessing "very" locks a board on a typo.
 */
export function parseStageGateMode(value: unknown): StageGateMode {
  const mode = String(value ?? "");
  return (STAGE_GATE_MODES as readonly string[]).includes(mode) ? (mode as StageGateMode) : "off";
}

/** Whether a stage carries anything worth showing in the settings summary. */
export function hasGate(gate: StageGate): boolean {
  return Boolean(gate.criteria && gate.criteria.conditions.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error("Stage criteria are not valid JSON");
  }
}
