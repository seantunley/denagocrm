/**
 * Triggers that only ever arrive as a JourneyEvent written by an application
 * write path (`emitLeadJourneyEvent`). Split out from the scheduled triggers
 * because they are the ones that silently enrolled NOBODY: the builder offered
 * every one of them, `emitJourneyEvent` was called from no write path at all,
 * and a journey built on one of them activated cleanly and then did nothing
 * forever. tests/oneAutomationEngine.test.ts now asserts, per trigger in this
 * list, that some write path emits it.
 */
export const JOURNEY_EVENT_TRIGGERS = [
  "lead_created",
  "stage_entered",
  "lead_won",
  "lead_lost",
  "quote_signed",
  "quote_declined",
  "delivered",
  "referral_earned",
] as const;

/** Triggers the cron enrols for by sweeping records (journeyScheduling.ts). */
export const JOURNEY_SCHEDULED_TRIGGERS = [
  "lead_idle",
  "contact_segment",
  "purchase_anniversary",
  "win_back",
] as const;

export const JOURNEY_TRIGGERS = [
  ...JOURNEY_EVENT_TRIGGERS,
  ...JOURNEY_SCHEDULED_TRIGGERS,
] as const;

export type JourneyEventTrigger = (typeof JOURNEY_EVENT_TRIGGERS)[number];
export type JourneyScheduledTrigger = (typeof JOURNEY_SCHEDULED_TRIGGERS)[number];
export type JourneyTrigger = (typeof JOURNEY_TRIGGERS)[number];

export const JOURNEY_STEP_TYPES = [
  "send_email",
  "send_sms",
  "create_activity",
  "send_push",
  "move_stage",
  "assign_user",
  // The lead OUTCOME steps. Everything above them changes where a lead sits or
  // who owns it; these three close it or put it back in play, which was the one
  // thing a journey could describe the trigger for (`lead_won`, `lead_lost`) and
  // could not itself do. See journeyLeadOutcome.ts for the transition table and
  // for why each is a conditional updateMany rather than an update-by-id.
  "lead_mark_won",
  "lead_mark_lost",
  "lead_reopen",
  "add_tag",
  "remove_tag",
  "wait",
  "condition",
  "stop",
  // Control-flow containers. Unlike every type above them these execute NO
  // action of their own — they own nested sequences and move the run's cursor.
  // See journeyCursor.ts for how a run parked inside one resumes.
  "choose",
  "repeat",
  // Two more that, like the containers above, perform no action of their own:
  // `wait_for_trigger` parks the run until a named event arrives for this
  // entity, and `variables` writes into the run context. Both
  // mutate RUN STATE rather than the outside world, so both are executed by the
  // runner — reaching journeyStepExecutor is a routing bug and says so.
  "wait_for_trigger",
  "variables",
  // Park until something BECOMES true. The other two waits cannot express it —
  // `wait` is a duration and answers "how long", and
  // `wait_for_trigger` needs a JourneyEvent somebody writes, so "wait until this
  // lead reaches Won" was only expressible as a fixed guess at how long that
  // takes. Like the other wait it parks the run on its own position, so the
  // runner owns it too.
  "wait_for_condition",
] as const;

export type JourneyStepType = (typeof JOURNEY_STEP_TYPES)[number];

/**
 * What each step type is CALLED on screen.
 *
 * Here rather than in the builder because the trace reads it too, and two copies
 * would drift the moment a step type is renamed — leaving the trace naming a
 * step differently from the builder the reader is comparing it against.
 */
export const JOURNEY_STEP_LABELS: Record<JourneyStepType, string> = {
  send_email: "Send email",
  send_sms: "Send SMS",
  create_activity: "Create activity",
  send_push: "Notify the team",
  move_stage: "Move lead stage",
  assign_user: "Assign lead",
  lead_mark_won: "Mark lead won",
  lead_mark_lost: "Mark lead lost",
  lead_reopen: "Reopen lead",
  add_tag: "Add contact tag",
  remove_tag: "Remove contact tag",
  wait: "Wait",
  condition: "Condition / branch",
  stop: "Stop journey",
  choose: "Choose (branches)",
  repeat: "Repeat (loop)",
  wait_for_trigger: "Wait for an event",
  variables: "Set variables",
  wait_for_condition: "Wait until true",
};

/** Container steps own nested sequences; the runner, not the executor, runs them. */
export const JOURNEY_CONTAINER_STEP_TYPES = ["choose", "repeat"] as const;

/**
 * Every step the RUNNER executes itself, containers included.
 *
 * The distinction the executor cares about is not "does it nest" but "does it
 * touch the cursor or the context" — a `wait_for_trigger` parks on its own frame
 * position and a `variables` step rewrites the context that the next step reads,
 * and the executor is handed neither.
 */
export const JOURNEY_RUNNER_STEP_TYPES = [
  ...JOURNEY_CONTAINER_STEP_TYPES,
  "wait_for_trigger",
  "variables",
  "wait_for_condition",
] as const;

/**
 * The steps that PARK the run on their own position and poll from there.
 *
 * Named as a set because the cursor carries exactly ONE armed wait — a run is
 * at one position, so it can only be waiting for one thing — and `armedWaitFor`
 * has to recognise every step type entitled to claim it. Spelled out here
 * rather than as a comparison in journeyWait.ts so adding a third wait cannot
 * leave a stale wait attached to a step that then re-arms it every tick.
 */
export const JOURNEY_WAIT_STEP_TYPES = ["wait_for_trigger", "wait_for_condition"] as const;

export const REPEAT_MODES = ["count", "while", "until", "for_each"] as const;
export type RepeatMode = (typeof REPEAT_MODES)[number];

export const CONDITION_FIELDS = [
  "lead.source",
  "lead.status",
  "lead.valueCents",
  "lead.quantity",
  "lead.stageId",
  "lead.productId",
  "lead.assignedToId",
  "lead.email",
  "lead.phone",
  "contact.source",
  "contact.province",
  "contact.marketingOptOut",
  "contact.email",
  "contact.phone",
  "contact.hasVehicle",
  "contact.tags",
  "event.type",
  /**
   * WHICH of a version's triggers enrolled this run, when the author named it.
   *
   * `event.type` above already tells two DIFFERENT trigger types apart, and for
   * most journeys that is the whole question. It cannot separate two triggers of
   * the SAME type — "entered Quoted" and "entered Won" are both `stage_entered`
   * — and that pairing is the obvious thing to want once a version may listen
   * for several things at once. The author's own id is the only thing that
   * distinguishes them, so it is published here.
   *
   * Empty for a trigger the author did not name, and for every version that
   * predates named triggers. Set once at enrolment and never rewritten: a
   * `wait_for_trigger` waking a run mid-sequence does not touch `context.event`,
   * so this keeps meaning "what let this person in".
   */
  "event.triggerId",
  // The loop variables a `repeat` publishes. Without these a `while`/`until`
  // condition can only look
  // at the lead or contact, and `for_each` would have no way to test the item it
  // is currently on — which is most of the point of iterating a list.
  "repeat.index",
  "repeat.item",
  "repeat.first",
  "repeat.last",
] as const;

/**
 * A journey variable name. Deliberately narrow, and never a bare context key.
 *
 * `variables` publishes into `context.vars`, so a condition names one as
 * `vars.<name>`. The prefix is the whole safety argument — see VARIABLE_FIELD.
 */
export const VARIABLE_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/**
 * The one condition field that is not in the list above, and it is open by
 * NAMESPACE rather than by name.
 *
 * The alternative was to let a `variables` step write bare context keys and
 * reject the ones that collide with the engine's own (`contact`, `lead`,
 * `event`, `repeat`, …). Rejected, for a reason this file has already lived
 * through: that reject-list is a MOVING TARGET. `repeat` became a context key
 * two commits ago and `vars` is becoming one now, and a published version is
 * immutable — so a journey saved today naming a variable `repeat` would pass
 * validation, ship, and then start silently reading the loop counter the day the
 * engine gained one. Nothing would error; a later step would just read the wrong
 * thing, which is exactly the failure mode being guarded against.
 *
 * Namespacing makes the collision impossible instead of merely currently-absent,
 * and it keeps CONDITION_FIELDS a closed allow-list: one prefix is added, not an
 * open set of identifiers. That matters — with bare names a typo'd `lead.sorce`
 * would have to be accepted as "probably a variable" and would then quietly
 * evaluate to undefined, which is precisely what the closed list exists to stop.
 */
export const VARIABLE_FIELD = /^vars\.[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

export type ConditionField = (typeof CONDITION_FIELDS)[number] | `vars.${string}`;
export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "in"
  | "is_empty"
  | "is_not_empty";

export type JourneyCondition = {
  field: ConditionField;
  operator: ConditionOperator;
  value?: unknown;
};

/**
 * `not` means NONE OF THESE: the group passes when every condition inside it is
 * invalid. So it is NOR, not "negate the first one" and not `!and(...)`.
 *
 * Spelled as a third `logic` rather than a `negate: true` flag on a group. A
 * flag would have made `{ logic: "or", negate: true }` and
 * `{ logic: "and", negate: true }` two more shapes to evaluate, explain and
 * render, for no expressiveness a nested group does not already give: `not` of a
 * nested `and` is `{ logic: "not", conditions: [{ logic: "and", … }] }`.
 */
export type JourneyConditionGroup = {
  logic: "and" | "or" | "not";
  conditions: Array<JourneyCondition | JourneyConditionGroup>;
};

export type JourneyStep = {
  id: string;
  name?: string;
  type: JourneyStepType;
  /**
   * TOP-LEVEL ONLY. Inside a nested sequence execution is positional — the next
   * step is the next element — and the parser rejects a nextStepId there, since
   * a jump out of a sequence would abandon the cursor frames that make the run
   * resumable.
   */
  nextStepId?: string | null;
  /**
   * Keep the run going when THIS step throws.
   *
   * One failed SMS threw, failed the whole run, and burned one of three run
   * attempts — so a provider outage on a "nice to have" notification could
   * permanently fail a journey whose remaining steps were the ones that mattered.
   * Marked per step because only the author knows which of their steps is
   * load-bearing. Control flow (stop / condition fail / abort) is NEVER
   * swallowed by it: those are decisions, not faults.
   */
  continueOnError?: boolean;
  /**
   * Whether this step runs at all. Absent or true means it runs; only a literal
   * `false` mutes it.
   *
   * The point is to mute a step WITHOUT deleting it — a send that is wrong this
   * month but right next month, a chase you want off while a promotion runs. The
   * alternative people actually reach for is deleting the step and retyping it
   * later, which loses its config, its id, and therefore its trace history.
   *
   * A disabled step is SKIPPED AND RECORDED AS SKIPPED. It is never quietly
   * passed over: the whole argument for the activity trace is that a step which
   * did nothing and said nothing is indistinguishable from a step that was never
   * reached, and "why did this customer not get the email" must be answerable
   * from the trace rather than by re-reading the definition.
   *
   * Read as `!== false` rather than `=== true`, like continueOnError, so every
   * definition written before this flag existed keeps the documented default.
   */
  enabled?: boolean;
  config: Record<string, unknown>;
};

export type JourneyDefinition = {
  startStepId: string | null;
  steps: JourneyStep[];
};

/**
 * Every user id an `assign_user` step in this definition would hand a lead to.
 *
 * Journeys assign people, so they are an assignment surface like any form — but
 * a stored one, which makes it the worse kind. `journeyStepExecutor` scopes the
 * LEAD it updates (`updateMany` with `tenantId`) and then writes whatever
 * `config.userId` says, unexamined; the builder's dropdown was fed by an
 * unscoped `user.findMany`. So a workspace could pick a stranger out of the list
 * once and have the engine reassign leads to them on every run afterwards, with
 * no one present to see a refusal. The caller checks these ids against the
 * shared contract before the definition is saved.
 *
 * The walk is over the RAW nested shape rather than the parsed `steps` array on
 * purpose: `choose` and `repeat` keep their children as ordinary objects inside
 * `config` (`options[].sequence`, `default`, `sequence`), so a definition whose
 * only assignment lives two branches deep would be missed by a top-level scan —
 * and "the check only covers unnested steps" is not a rule anybody would keep in
 * their head. Matching on shape rather than on those key names also means a new
 * kind of container cannot quietly open the hole again.
 *
 * Safe to run on parser output without a depth guard of its own: nesting depth
 * and total step count are already capped by JOURNEY_LIMITS, and this is only
 * ever called on a definition `parseJourneyDefinition` has returned.
 */
export function collectAssignedUserIds(value: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    if (node.type === "assign_user" && isRecord(node.config)) {
      const userId = node.config.userId;
      if (typeof userId === "string" && userId.trim() !== "") found.add(userId.trim());
    }
    for (const item of Object.values(node)) walk(item);
  };
  walk(value);
  return [...found];
}

/**
 * The ceilings. Every one of them exists because the cron calls this engine and
 * an unbounded definition is a denial of service against our own scheduler.
 *
 *  steps (100)            — TOTAL nodes at every depth, not just top level. The
 *                           old cap counted the flat array, which nesting makes
 *                           meaningless: 50 top-level `choose` steps with ten
 *                           branches each would have passed a 50-step check
 *                           while carrying 500 actions. Doubled from 50 because
 *                           `choose` makes branching cheap to express and the
 *                           previous limit was calibrated against hand-nested
 *                           condition steps.
 *  depth (5)              — bounds recursion in the parser AND the length of the
 *                           cursor frame stack that has to survive in a JSON
 *                           column between ticks. Five is already deeper than a
 *                           person can hold in their head.
 *  chooseOptions (10)     — more than ten is a lookup table, not a branch, and
 *                           nobody reviewing a journey can hold it in their
 *                           head. Past that, use nested chooses or a repeat.
 *  conditionsPerGroup(30) — unchanged, and now bounded overall by depth × steps.
 *  repeatIterations (100) — the runtime ceiling for EVERY repeat mode. A `while`
 *                           whose condition never goes false is the classic
 *                           infinite automation; 100 iterations of real work is
 *                           already more than a marketing journey should do to
 *                           one person, and hitting it aborts with a message
 *                           naming the loop instead of spinning forever.
 *  forEachItems (100)     — the list is SNAPSHOT into the cursor at loop entry,
 *                           so this also caps how much JSON one parked run
 *                           carries.
 *  triggers (5)           — ENROLMENT triggers on one published version. Five is
 *                           the same judgement as waitTriggers below and for the
 *                           same reason: a list of alternatives longer than that
 *                           is not one journey's front door, it is two journeys.
 *                           The matcher's cost is not the constraint — it walks
 *                           this list in memory, per active journey, per event —
 *                           the reader's is.
 *  waitTriggers (5)       — how many event types ONE wait_for_trigger may watch.
 *                           Each one widens an indexed query the waiter runs on
 *                           every poll; five is more alternatives than a person
 *                           can reason about in a single wait anyway.
 *  waitDays (30)          — the ceiling on a wait_for_trigger OR
 *                           wait_for_condition timeout, and the reason a
 *                           timeout is REQUIRED on both. A parked wait is not a
 *                           live object anybody can see and cancel; it is a
 *                           database row that would poll on every cron tick,
 *                           forever, until a person happened to notice it.
 *                           "Wait indefinitely" is not expressible on purpose.
 *  variables (10)         — names one `variables` step may set.
 *  variableChars (500)    — per rendered value.
 *  variableBytes (4000)   — the WHOLE bag, across every variables step in the
 *                           run. This is the one that actually matters: the
 *                           context is written back as JSON after every single
 *                           step, so an unbounded bag inflates every write for
 *                           the remaining life of the run — and a run can live
 *                           for weeks. 4 kB is ~8 full-length values.
 *  leadOutcomeReason(200) — a `lead_mark_lost` reason, before and after
 *                           rendering. It lands in `Lead.lostReason`, which the
 *                           reports screen groups by, so an essay there is a
 *                           bucket of one. The same number bounds the TEMPLATE
 *                           at save time and the RENDERED value at run time —
 *                           the template is what a person types, the rendered
 *                           string is what reaches the column, and only the
 *                           second one is what the column actually gets.
 */
export const JOURNEY_LIMITS = {
  steps: 100,
  depth: 5,
  chooseOptions: 10,
  conditionsPerGroup: 30,
  repeatIterations: 100,
  forEachItems: 100,
  triggers: 5,
  waitTriggers: 5,
  waitDays: 30,
  variables: 10,
  variableChars: 500,
  variableBytes: 4000,
  leadOutcomeReason: 200,
} as const;

const STEP_TYPES = new Set<string>(JOURNEY_STEP_TYPES);
const FIELDS = new Set<string>(CONDITION_FIELDS);
const EVENT_TRIGGERS = new Set<string>(JOURNEY_EVENT_TRIGGERS);
const OPERATORS = new Set<string>([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
  "in",
  "is_empty",
  "is_not_empty",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(clean) ? clean : null;
}

export function parseConditionGroup(value: unknown): JourneyConditionGroup | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error("Conditions must be an object");
  // Unknown logic falls back to "and", as it always has. That is deliberately
  // NOT a throw: entryConditions and choose options are stored JSON that
  // predates this field, and the permissive reading is the one every existing
  // journey was saved under.
  const logic = value.logic === "or" ? "or" : value.logic === "not" ? "not" : "and";
  if (!Array.isArray(value.conditions)) throw new Error("Conditions must contain a list");
  if (value.conditions.length > JOURNEY_LIMITS.conditionsPerGroup) {
    throw new Error(`A journey may contain at most ${JOURNEY_LIMITS.conditionsPerGroup} conditions`);
  }

  const conditions = value.conditions.map((condition) => {
    if (!isRecord(condition)) throw new Error("Invalid journey condition");
    if (Array.isArray(condition.conditions)) {
      const nested = parseConditionGroup(condition);
      if (!nested) throw new Error("Invalid nested condition group");
      return nested;
    }
    const field = String(condition.field ?? "");
    const operator = String(condition.operator ?? "");
    // The closed allow-list, plus the ONE namespace a journey may extend it
    // with. `vars.x` resolves through the same valueAtPath dot-walk as every
    // other field — `vars` is a flat map of strings, so there is nothing below
    // it to walk into.
    if (!FIELDS.has(field) && !VARIABLE_FIELD.test(field)) {
      throw new Error(`Unsupported condition field: ${field}`);
    }
    if (!OPERATORS.has(operator)) throw new Error(`Unsupported condition operator: ${operator}`);
    return {
      field: field as ConditionField,
      operator: operator as ConditionOperator,
      value: condition.value,
    };
  });

  return { logic, conditions };
}

/** Shared budget so nested sequences count against ONE definition-wide ceiling. */
type ParseBudget = { ids: Set<string>; remaining: number };

function newBudget(ids = new Set<string>()): ParseBudget {
  return { ids, remaining: JOURNEY_LIMITS.steps };
}

/**
 * id / type / nextStepId / config — everything true of a step at any depth.
 *
 * `nested` is what makes a sequence step different from a top-level one: a
 * sequence runs in order, so a nextStepId (or a condition's trueStepId) inside
 * one would have to jump to a TOP-LEVEL id, silently abandoning the cursor
 * frames that make the enclosing repeat resumable. Rejecting it at save time is
 * the only place that mistake is cheap.
 */
function parseStepHeader(raw: unknown, budget: ParseBudget, nested: boolean): JourneyStep {
  if (!isRecord(raw)) throw new Error("Invalid journey step");
  if (budget.remaining <= 0) {
    throw new Error(`A journey may contain at most ${JOURNEY_LIMITS.steps} steps`);
  }
  budget.remaining -= 1;

  const id = cleanId(raw.id);
  if (!id) throw new Error("Each step needs a safe unique ID");
  if (budget.ids.has(id)) throw new Error(`Duplicate step ID: ${id}`);
  budget.ids.add(id);

  const type = String(raw.type ?? "");
  if (!STEP_TYPES.has(type)) throw new Error(`Unsupported journey step: ${type}`);

  const nextStepId = raw.nextStepId == null || raw.nextStepId === "" ? null : cleanId(raw.nextStepId);
  if (raw.nextStepId && !nextStepId) throw new Error(`Invalid next step for ${id}`);
  if (nested && nextStepId) {
    throw new Error(`Step ${id} is inside a sequence and may not set nextStepId — a sequence runs in order`);
  }

  const step: JourneyStep = {
    id,
    type: type as JourneyStepType,
    name: typeof raw.name === "string" ? raw.name.slice(0, 120) : undefined,
    nextStepId,
    config: isRecord(raw.config) ? raw.config : {},
  };
  if (raw.continueOnError === true) step.continueOnError = true;
  // Only a literal `false` is stored. `enabled: true` is the default and is
  // dropped rather than round-tripped, so the saved JSON says nothing about the
  // steps that are simply on — and an older definition, which says nothing at
  // all, means the same thing.
  if (raw.enabled === false) step.enabled = false;
  return step;
}

function parseStep(raw: unknown, budget: ParseBudget, depth: number, nested: boolean): JourneyStep {
  const step = parseStepHeader(raw, budget, nested);
  const { type, id, config } = step;

  if (type === "condition") {
    parseConditionGroup(config.condition);
    if (nested) {
      for (const key of ["trueStepId", "falseStepId"] as const) {
        if (config[key] != null && config[key] !== "") {
          throw new Error(`Condition ${id} is inside a sequence; use choose for branching, not ${key}`);
        }
      }
    }
  }
  if (type === "choose") parseChooseConfig(config, budget, depth);
  if (type === "repeat") parseRepeatConfig(config, budget, depth);
  // Both are validated by the SAME function the runner calls, not a second copy
  // of the rules. A wait whose triggers only the save path checks is a wait that
  // parks forever the first time the two drift apart.
  if (type === "wait_for_trigger") parseWaitForTriggerConfig(config);
  if (type === "wait_for_condition") parseWaitForConditionConfig(config);
  if (type === "variables") parseVariablesConfig(config);
  if (isLeadOutcomeStep(type)) parseLeadOutcomeConfig(type, config);
  return step;
}

function parseSequenceInternal(
  value: unknown,
  budget: ParseBudget,
  depth: number,
  label: string,
): JourneyStep[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list of steps`);
  // An EMPTY sequence would break the runner's central invariant: entering a
  // container pushes a cursor frame at index 0, and that index must name a real
  // step. Rejecting it here is cheaper than a cursor that points at nothing
  // three days into a parked run.
  if (value.length === 0) throw new Error(`${label} must contain at least one step`);
  return value.map((raw) => parseStep(raw, budget, depth, true));
}

/**
 * A branch's steps, validated on their own.
 *
 * Exported for the LAZY path: the runner parses the top level only, and calls
 * this for a branch the moment that branch is first entered. Ten `choose`
 * options therefore cost one option's validation, not ten, on every tick — which
 * is the whole point, since processOneRun re-parses the definition each time it
 * picks a run up.
 */
export function parseJourneySequence(value: unknown, depth = 1, label = "Sequence"): JourneyStep[] {
  return parseSequenceInternal(value, newBudget(), depth, label);
}

function assertDepth(depth: number, what: string) {
  if (depth >= JOURNEY_LIMITS.depth) {
    throw new Error(`${what} is nested more than ${JOURNEY_LIMITS.depth} levels deep`);
  }
}

function parseChooseConfig(config: Record<string, unknown>, budget: ParseBudget, depth: number) {
  assertDepth(depth, "choose");
  const options = config.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error("A choose step needs at least one option");
  }
  if (options.length > JOURNEY_LIMITS.chooseOptions) {
    throw new Error(`A choose step may have at most ${JOURNEY_LIMITS.chooseOptions} options`);
  }
  options.forEach((option, index) => {
    if (!isRecord(option)) throw new Error(`Choose option ${index} is not an object`);
    parseConditionGroup(option.conditions);
    parseSequenceInternal(option.sequence, budget, depth + 1, `Choose option ${index}`);
  });
  if (config.default != null) {
    parseSequenceInternal(config.default, budget, depth + 1, "Choose default");
  }
}

/** A dot path into the run context, e.g. `contact.tags`. Deliberately narrow. */
const SAFE_PATH = /^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+){0,4}$/;

function parseRepeatConfig(config: Record<string, unknown>, budget: ParseBudget, depth: number) {
  assertDepth(depth, "repeat");
  const mode = String(config.mode ?? "");
  if (!(REPEAT_MODES as readonly string[]).includes(mode)) {
    throw new Error(`Unsupported repeat mode: ${mode || "(none)"}`);
  }
  if (mode === "count") {
    const count = Number(config.count);
    if (!Number.isInteger(count) || count < 1 || count > JOURNEY_LIMITS.repeatIterations) {
      throw new Error(`A repeat count must be between 1 and ${JOURNEY_LIMITS.repeatIterations}`);
    }
  }
  if (mode === "while" || mode === "until") {
    const group = parseConditionGroup(config[mode]);
    // A while/until with no clauses evaluates TRUE (evaluateConditions treats an
    // empty group as "no filter"), which is an infinite loop that only the
    // iteration ceiling would stop — hours later, having sent 100 messages.
    if (!group || group.conditions.length === 0) {
      throw new Error(`A repeat ${mode} needs at least one condition, or it never ends`);
    }
  }
  if (mode === "for_each") {
    const { items, itemsPath } = config;
    if (Array.isArray(items)) {
      if (items.length > JOURNEY_LIMITS.forEachItems) {
        throw new Error(`A for_each may iterate at most ${JOURNEY_LIMITS.forEachItems} items`);
      }
    } else if (typeof itemsPath === "string") {
      if (!SAFE_PATH.test(itemsPath)) throw new Error(`Unsafe for_each itemsPath: ${itemsPath}`);
    } else {
      throw new Error("A for_each repeat needs items or itemsPath");
    }
  }
  parseSequenceInternal(config.sequence, budget, depth + 1, "Repeat sequence");
}

/* ── wait_for_trigger ────────────────────────────────────────────────────── */

export type WaitForTriggerConfig = {
  /** Event types that may wake the run. Any ONE of them is enough. */
  triggers: JourneyEventTrigger[];
  /** Minutes. REQUIRED — see JOURNEY_LIMITS.waitDays for why. */
  timeoutMinutes: number;
  /** Default true: carry on past a timeout rather than ending the run. */
  continueOnTimeout: boolean;
};

export const WAIT_TIMEOUT_MAX_MINUTES = JOURNEY_LIMITS.waitDays * 24 * 60;

/**
 * The timeout rule, stated ONCE for every step that parks and polls.
 *
 * REQUIRED, and capped, for the reason spelled out at JOURNEY_LIMITS.waitDays:
 * a parked wait is not a live object somebody can see and cancel, it is a
 * database row that would poll on every cron tick until a person noticed.
 * "Wait indefinitely" is not expressible on purpose, and it has to be
 * un-expressible for BOTH waits or the ceiling is a suggestion.
 */
function parseWaitTimeoutMinutes(config: Record<string, unknown>, what: string): number {
  const timeoutMinutes = Number(config.timeoutMinutes);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > WAIT_TIMEOUT_MAX_MINUTES) {
    throw new Error(
      `A ${what} needs timeoutMinutes between 1 and ${WAIT_TIMEOUT_MAX_MINUTES} (${JOURNEY_LIMITS.waitDays} days)`,
    );
  }
  return timeoutMinutes;
}

/**
 * A `wait_for_trigger` step's config — the SAME parse the runner uses.
 *
 * Only JOURNEY_EVENT_TRIGGERS are accepted. Those are the event types some
 * application write path actually emits (tests/oneAutomationEngine.test.ts
 * asserts it, per trigger); anything else is a name nothing will ever produce,
 * so waiting on it is a guaranteed timeout dressed up as a feature. The
 * SCHEDULED triggers are excluded too — the cron enrols on those by sweeping
 * records, it does not write a JourneyEvent a waiter could ever see.
 */
export function parseWaitForTriggerConfig(config: Record<string, unknown>): WaitForTriggerConfig {
  const raw = config.triggers;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? [raw] : [];
  if (list.length === 0) throw new Error("A wait_for_trigger needs at least one trigger");
  if (list.length > JOURNEY_LIMITS.waitTriggers) {
    throw new Error(`A wait_for_trigger may watch at most ${JOURNEY_LIMITS.waitTriggers} triggers`);
  }
  const triggers = list.map((value) => {
    const name = String(value);
    if (!EVENT_TRIGGERS.has(name)) {
      throw new Error(`A wait_for_trigger cannot wait for "${name}" — nothing emits it`);
    }
    return name as JourneyEventTrigger;
  });
  if (new Set(triggers).size !== triggers.length) {
    throw new Error("A wait_for_trigger lists the same trigger twice");
  }

  const timeoutMinutes = parseWaitTimeoutMinutes(config, "wait_for_trigger");

  // Default TRUE: only an explicit `false` stops the run. Written
  // as `!== false` rather than `=== true` so a config that predates the flag,
  // or omits it, gets the documented default instead of the strict one.
  return { triggers, timeoutMinutes, continueOnTimeout: config.continueOnTimeout !== false };
}

/* ── wait_for_condition ──────────────────────────────────────────────────── */

export type WaitForConditionConfig = {
  /** What has to become true. At least one clause — see below. */
  condition: JourneyConditionGroup;
  /** Minutes. REQUIRED, and capped, exactly as wait_for_trigger's is. */
  timeoutMinutes: number;
  /** Default true: carry on past a timeout rather than ending the run. */
  continueOnTimeout: boolean;
};

/**
 * A `wait_for_condition` step's config — the SAME parse the runner uses.
 *
 * The condition may not be EMPTY, and that is not tidiness. `evaluateConditions`
 * reads an empty group as "no filter" and returns true, so an empty wait is
 * satisfied the instant it is reached: a step that renders in the builder as
 * "wait until…", traces as "condition was already true", and waits for nothing
 * at all. It is the same trap `repeat while` already refuses, reached from the
 * other side — there an empty group loops forever, here it never waits — and it
 * is far cheaper to refuse at save time than to explain a month later.
 */
export function parseWaitForConditionConfig(config: Record<string, unknown>): WaitForConditionConfig {
  const condition = parseConditionGroup(config.condition);
  if (!condition || condition.conditions.length === 0) {
    throw new Error("A wait_for_condition needs at least one condition, or it never waits");
  }
  return {
    condition,
    timeoutMinutes: parseWaitTimeoutMinutes(config, "wait_for_condition"),
    continueOnTimeout: config.continueOnTimeout !== false,
  };
}

/* ── variables ───────────────────────────────────────────────────────────── */

export type JourneyVariableAssignment = { name: string; template: string };

/**
 * A `variables` step's config: a FLAT map of name → template string.
 *
 * Flat and string-only on purpose. A nested value would have to be walked by
 * conditions and rendered into templates, and `renderTemplate` can only
 * substitute a flat key — so a nested variable would validate, save, and then
 * render as nothing. The cap on the template's own length is the cheap half of
 * bounding the bag; the rendered total is checked at run time, where the data
 * is (journeyVariables.ts).
 */
export function parseVariablesConfig(config: Record<string, unknown>): JourneyVariableAssignment[] {
  const set = config.set;
  if (!isRecord(set)) throw new Error("A variables step needs a `set` map of name → template");
  const entries = Object.entries(set);
  if (entries.length === 0) throw new Error("A variables step must set at least one variable");
  if (entries.length > JOURNEY_LIMITS.variables) {
    throw new Error(`A variables step may set at most ${JOURNEY_LIMITS.variables} variables`);
  }
  return entries.map(([name, template]) => {
    // Rejects `__proto__`, dots, and anything that could not be addressed as
    // `vars.<name>` in a condition or `var_<name>` in a template.
    if (!VARIABLE_NAME.test(name)) throw new Error(`Unsafe variable name: ${name}`);
    if (typeof template !== "string") throw new Error(`Variable ${name} must be a template string`);
    if (template.length > JOURNEY_LIMITS.variableChars) {
      throw new Error(`Variable ${name}'s template is longer than ${JOURNEY_LIMITS.variableChars} characters`);
    }
    return { name, template };
  });
}

/* ── lead outcome ────────────────────────────────────────────────────────── */

/**
 * The three steps that close a lead or put it back in play.
 *
 * Named here rather than in journeyLeadOutcome.ts so the parser can reach them
 * without importing that module — journeyLeadOutcome imports THIS file for the
 * config parse, and a cycle between the two would be paid for on every tick.
 */
export const LEAD_OUTCOME_STEP_TYPES = [
  "lead_mark_won",
  "lead_mark_lost",
  "lead_reopen",
] as const satisfies readonly JourneyStepType[];

export type LeadOutcomeStepType = (typeof LEAD_OUTCOME_STEP_TYPES)[number];

const LEAD_OUTCOME_TYPES = new Set<string>(LEAD_OUTCOME_STEP_TYPES);

export function isLeadOutcomeStep(type: string): type is LeadOutcomeStepType {
  return LEAD_OUTCOME_TYPES.has(type);
}

export type LeadOutcomeConfig = {
  /**
   * `lead_mark_lost` only, and a TEMPLATE — the same `{{first_name}}`-style
   * substitution every other authored string in a journey gets. Null for the
   * other two, which take no configuration at all.
   */
  reason: string | null;
};

/**
 * A lead-outcome step's config — the SAME parse the runner uses.
 *
 * The one rule worth having is that `lead_mark_lost` MUST carry a reason.
 * `markLost` (the staff action) refuses without one — "A lost reason is
 * required" — and the reports screen groups closed-lost leads by that column, so
 * a journey allowed to write a bare `lost` would quietly grow a bucket of
 * unexplained losses that no report can account for. Enforced at SAVE time
 * rather than skipped at run time because the author is standing there when they
 * save; three days into a run, "skipped: no reason configured" is a message
 * nobody is watching for.
 *
 * Existing published versions cannot be broken by this: no version predates
 * these step types, so there is nothing already in flight for the rule to fail.
 */
export function parseLeadOutcomeConfig(
  type: LeadOutcomeStepType,
  config: Record<string, unknown>,
): LeadOutcomeConfig {
  if (type !== "lead_mark_lost") return { reason: null };
  const raw = config.reason;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("A mark-lost step needs a reason — a lost lead with no reason is invisible in reports");
  }
  if (raw.length > JOURNEY_LIMITS.leadOutcomeReason) {
    throw new Error(
      `A mark-lost reason must be ${JOURNEY_LIMITS.leadOutcomeReason} characters or fewer`,
    );
  }
  return { reason: raw.trim() };
}

/**
 * Validate a whole definition.
 *
 * `deep` (the default) walks every nested sequence, and is what SAVE and PUBLISH
 * use — the one place where paying for full validation is right, because it is
 * the only place a person is waiting to be told their journey is wrong.
 *
 * `deep: false` validates the top level only and is what the RUNNER uses. It
 * re-parses on every tick for every run, and validating ten `choose` branches to
 * execute one of them is work nobody asked for. The branch actually entered is
 * validated on entry by parseJourneySequence, and cached (journeyScript.ts), so
 * nothing skips validation — it is only deferred to the branch that runs.
 */
export function parseJourneyDefinition(
  value: unknown,
  opts: { deep?: boolean } = {},
): JourneyDefinition {
  const deep = opts.deep !== false;
  if (!isRecord(value)) throw new Error("Journey definition must be an object");
  if (!Array.isArray(value.steps)) throw new Error("Journey definition must contain steps");
  if (value.steps.length > JOURNEY_LIMITS.steps) {
    throw new Error(`A journey may contain at most ${JOURNEY_LIMITS.steps} steps`);
  }

  const budget = newBudget();
  const steps: JourneyStep[] = value.steps.map((raw) => {
    // Shallow: a container's HEADER is still checked (an unknown type or a
    // duplicate id is broken however lazily you look at it) but its branches are
    // left for the runner to prepare on entry.
    const containerShallow =
      !deep && isRecord(raw) && (raw.type === "choose" || raw.type === "repeat");
    return containerShallow
      ? parseStepHeader(raw, budget, false)
      : parseStep(raw, budget, 0, false);
  });

  // Only TOP-LEVEL ids are jump targets. A nested step's id exists for the trace,
  // not for navigation.
  const topLevel = new Set(steps.map((step) => step.id));
  const startStepId = value.startStepId == null ? null : cleanId(value.startStepId);
  if (value.startStepId && !startStepId) throw new Error("Invalid starting step");
  if (startStepId && !topLevel.has(startStepId)) throw new Error("Starting step does not exist");

  for (const step of steps) {
    if (step.nextStepId && !topLevel.has(step.nextStepId)) {
      throw new Error(`Step ${step.id} points to a missing next step`);
    }
    if (step.type === "condition") {
      for (const key of ["trueStepId", "falseStepId"] as const) {
        const target = step.config[key];
        if (target != null && target !== "") {
          const clean = cleanId(target);
          if (!clean || !topLevel.has(clean)) throw new Error(`Condition ${step.id} has an invalid ${key}`);
        }
      }
    }
  }

  assertNoTopLevelCycle(steps);
  return { startStepId, steps };
}

/**
 * Refuse a cycle in the TOP-LEVEL jump graph.
 *
 * A back-edge — `a → b → a` through nextStepId, or through a condition's
 * trueStepId/falseStepId — is a loop written as GOTO, and it breaks two things
 * at once now that steps can nest:
 *
 *  - THE TRACE CANNOT REPRESENT IT. A top-level step's trace path is exactly
 *    its id, and JourneyStepLog is upserted on (runId, path). So the second
 *    visit silently overwrites the first, and the activity trace — whose entire
 *    job is showing what actually happened — shows only the latest pass, with
 *    no sign the earlier ones existed.
 *  - NOTHING BOUNDS IT. The per-tick `visited` Set that used to catch this was
 *    removed, correctly: a `repeat` revisits step ids by design, so the Set
 *    called every legitimate loop a cycle. But it was also too weak for the
 *    real case, because it was rebuilt empty on each tick — a back-edge with a
 *    `wait` in it went round forever, one step per tick, and was never seen
 *    twice.
 *
 * A static check is the right replacement for exactly that reason: it catches
 * the wait-in-the-loop case the runtime Set could not, and it costs one pass
 * over at most `JOURNEY_LIMITS.steps` nodes.
 *
 * CONVERGENCE STAYS LEGAL. Two branches meeting at one step (`a → c`, `b → c`)
 * is not a cycle and executes `c` once; only a genuine back-edge is refused.
 *
 * Looping is not being taken away — `repeat` is the construct for it, and it is
 * the one the cursor, the iteration ceiling and the trace path can all model.
 */
function assertNoTopLevelCycle(steps: JourneyStep[]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const targets = (step: JourneyStep): string[] => {
    const out: string[] = [];
    if (step.nextStepId) out.push(step.nextStepId);
    if (step.type === "condition") {
      for (const key of ["trueStepId", "falseStepId"] as const) {
        const target = step.config[key];
        if (typeof target === "string" && target) out.push(target);
      }
    }
    return out;
  };

  // Iterative DFS with an explicit colour map: recursion here would be bounded
  // by JOURNEY_LIMITS.steps, but the stack depth is the author's to choose and
  // a definition is not trusted input.
  const state = new Map<string, "open" | "done">();
  for (const root of steps) {
    if (state.get(root.id) === "done") continue;
    const stack: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    state.set(root.id, "open");
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const step = byId.get(frame.id);
      const edges = step ? targets(step) : [];
      if (frame.next >= edges.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const child = edges[frame.next++];
      if (state.get(child) === "open") {
        throw new Error(
          `Step ${frame.id} loops back to ${child}. Use a repeat step for loops — a back-edge cannot be traced, because every pass would overwrite the last.`,
        );
      }
      if (state.get(child) !== "done" && byId.has(child)) {
        state.set(child, "open");
        stack.push({ id: child, next: 0 });
      }
    }
  }
}

/** Exported for `for_each`'s itemsPath, which resolves against the same context. */
export function valueAtPath(context: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!isRecord(current)) return undefined;
    return current[key];
  }, context);
}

function empty(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }
  return null;
}

function compare(condition: JourneyCondition, actual: unknown): boolean {
  const expected = condition.value;
  switch (condition.operator) {
    case "is_empty": return empty(actual);
    case "is_not_empty": return !empty(actual);
    case "equals": return String(actual ?? "") === String(expected ?? "");
    case "not_equals": return String(actual ?? "") !== String(expected ?? "");
    case "contains":
      return Array.isArray(actual)
        ? actual.map(String).includes(String(expected ?? ""))
        : String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "not_contains":
      return !compare({ ...condition, operator: "contains" }, actual);
    case "in": {
      const choices = Array.isArray(expected)
        ? expected.map(String)
        : String(expected ?? "").split(",").map((v) => v.trim()).filter(Boolean);
      return choices.includes(String(actual ?? ""));
    }
    default: {
      const left = numeric(actual);
      const right = numeric(expected);
      if (left == null || right == null) return false;
      if (condition.operator === "greater_than") return left > right;
      if (condition.operator === "greater_or_equal") return left >= right;
      if (condition.operator === "less_than") return left < right;
      return left <= right;
    }
  }
}

/** One clause's verdict, for the trace. */
export type ConditionExplanation = {
  field: string;
  operator: string;
  expected: unknown;
  actual: unknown;
  /**
   * The COMPARISON's own result — did `actual` match `expected`. Unchanged by
   * negation, on purpose: this field answers "what did the clause see and how
   * did that compare", which is a fact about the data and must not flip
   * meaning depending on where the clause sits.
   */
  passed: boolean;
  /**
   * True when an ODD number of enclosing `not` groups apply to this clause.
   *
   * Without it the flattened trace is actively misleading under a `not`: the
   * clause that PASSED is the one that made the group fail, and a reader
   * scanning for ✗ would find nothing wrong and conclude the engine was broken.
   * That is the "Condition did not match" defect again, one level down.
   *
   * Read together with `passed` through `clauseHeld` — never on its own.
   */
  negated: boolean;
};

/**
 * Did this clause help its group pass?
 *
 * The one place the two fields are combined, so the trace UI and any test agree
 * on what a tick means. Under a `not`, a clause holds by NOT matching.
 */
export function clauseHeld(clause: { passed: boolean; negated?: boolean }): boolean {
  return clause.negated ? !clause.passed : clause.passed;
}

/**
 * The per-clause result behind a condition's verdict.
 *
 * "Condition did not match" is true and useless: it sends someone re-reading
 * every clause by hand against a lead whose values have since changed. This
 * records what each clause actually compared, so the trace answers the question
 * instead of posing it: the path taken is visible, and each node carries its
 * own result.
 *
 * Nested groups are flattened: the field/operator pairs are what a reader is
 * looking for, and the group structure is already visible in the builder.
 *
 * ── What flattening does and does not promise, now that `not` exists ────────
 *
 * These rows are DIAGNOSTIC, not a re-derivation of the verdict. The verdict is
 * recorded separately, as `output.passed`, by whoever ran the group — and it
 * has to be, because a flat list cannot express composition: an `or` where one
 * clause shows ✗ still passed, and that has been true since per-clause results
 * were added. Nothing here changes that contract.
 *
 * What `not` WOULD have broken, and what `negated` fixes, is worse than
 * imprecision. Under a `not`, a clause that matched is the reason the group
 * failed — so a reader scanning the rows for a ✗ would find every clause green
 * beside a step that did not match, and conclude the engine was lying. Carrying
 * the negation makes each row state what it was actually asked to do: required,
 * or excluded.
 *
 * `depth` is parity, not a count: two `not`s cancel, exactly as they do in the
 * evaluation.
 */
export function explainConditions(
  group: JourneyConditionGroup | null,
  context: Record<string, unknown>,
  negated = false,
): ConditionExplanation[] {
  if (!group) return [];
  const inner = group.logic === "not" ? !negated : negated;
  return group.conditions.flatMap((condition) => {
    if ("conditions" in condition) return explainConditions(condition, context, inner);
    const actual = valueAtPath(context, condition.field);
    return [{
      field: condition.field,
      operator: condition.operator,
      expected: condition.value,
      actual,
      passed: compare(condition, actual),
      negated: inner,
    }];
  });
}

export function evaluateConditions(
  group: JourneyConditionGroup | null,
  context: Record<string, unknown>
): boolean {
  // An empty group is "no filter" and passes — including an empty `not`, which
  // agrees with the rule below: NOR of nothing is true. The two must agree, or
  // deleting the last clause from a `not` would flip an entry filter from
  // "everyone except X" to "nobody", silently, on save.
  if (!group || group.conditions.length === 0) return true;
  const results = group.conditions.map((condition) =>
    "conditions" in condition
      ? evaluateConditions(condition, context)
      : compare(condition, valueAtPath(context, condition.field))
  );
  // `not` is NOR — "none of these are valid" — because it takes a LIST. It is
  // not "negate the first clause", and it is not `!and(...)`: `not` over [a, b]
  // excludes a AND excludes b.
  if (group.logic === "not") return !results.some(Boolean);
  return group.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}

export function stepById(definition: JourneyDefinition, id: string | null | undefined) {
  return id ? definition.steps.find((step) => step.id === id) ?? null : null;
}
