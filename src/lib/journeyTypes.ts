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
  // Two more from Home Assistant's script syntax, and like the containers above
  // they perform no action: `wait_for_trigger` parks the run until a named event
  // arrives for this entity, and `variables` writes into the run context. Both
  // mutate RUN STATE rather than the outside world, so both are executed by the
  // runner — reaching journeyStepExecutor is a routing bug and says so.
  "wait_for_trigger",
  "variables",
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
  add_tag: "Add contact tag",
  remove_tag: "Remove contact tag",
  wait: "Wait",
  condition: "Condition / branch",
  stop: "Stop journey",
  choose: "Choose (branches)",
  repeat: "Repeat (loop)",
  wait_for_trigger: "Wait for an event",
  variables: "Set variables",
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
] as const;

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
  // The loop variables a `repeat` publishes, after Home Assistant's `repeat`
  // template variable. Without these a `while`/`until` condition can only look
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

export type JourneyConditionGroup = {
  logic: "and" | "or";
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
   * After Home Assistant's per-action `continue_on_error`.
   *
   * One failed SMS threw, failed the whole run, and burned one of three run
   * attempts — so a provider outage on a "nice to have" notification could
   * permanently fail a journey whose remaining steps were the ones that mattered.
   * Marked per step because only the author knows which of their steps is
   * load-bearing. Control flow (stop / condition fail / abort) is NEVER
   * swallowed by it: those are decisions, not faults.
   */
  continueOnError?: boolean;
  config: Record<string, unknown>;
};

export type JourneyDefinition = {
  startStepId: string | null;
  steps: JourneyStep[];
};

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
 *  chooseOptions (10)     — matches the ten-branch case in HA's own docs; more
 *                           than that is a lookup table, not a branch.
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
 *  waitTriggers (5)       — how many event types ONE wait_for_trigger may watch.
 *                           Each one widens an indexed query the waiter runs on
 *                           every poll; five is more alternatives than a person
 *                           can reason about in a single wait anyway.
 *  waitDays (30)          — the ceiling on a wait_for_trigger timeout, and the
 *                           reason a timeout is REQUIRED here when Home
 *                           Assistant makes it optional. HA can wait forever
 *                           because its script is a live object you can see and
 *                           cancel; ours is a database row that would poll on
 *                           every cron tick until someone noticed. "Forever" is
 *                           not expressible on purpose.
 *  variables (10)         — names one `variables` step may set.
 *  variableChars (500)    — per rendered value.
 *  variableBytes (4000)   — the WHOLE bag, across every variables step in the
 *                           run. This is the one that actually matters: the
 *                           context is written back as JSON after every single
 *                           step, so an unbounded bag inflates every write for
 *                           the remaining life of the run — and a run can live
 *                           for weeks. 4 kB is ~8 full-length values.
 */
export const JOURNEY_LIMITS = {
  steps: 100,
  depth: 5,
  chooseOptions: 10,
  conditionsPerGroup: 30,
  repeatIterations: 100,
  forEachItems: 100,
  waitTriggers: 5,
  waitDays: 30,
  variables: 10,
  variableChars: 500,
  variableBytes: 4000,
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
  const logic = value.logic === "or" ? "or" : "and";
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
  if (type === "variables") parseVariablesConfig(config);
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
  /** Event types that may wake the run. Any ONE of them is enough, as in HA. */
  triggers: JourneyEventTrigger[];
  /** Minutes. REQUIRED — see JOURNEY_LIMITS.waitDays for why HA differs. */
  timeoutMinutes: number;
  /** HA's `continue_on_timeout`, default true: carry on past a timeout. */
  continueOnTimeout: boolean;
};

export const WAIT_TIMEOUT_MAX_MINUTES = JOURNEY_LIMITS.waitDays * 24 * 60;

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

  const timeoutMinutes = Number(config.timeoutMinutes);
  if (!Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > WAIT_TIMEOUT_MAX_MINUTES) {
    throw new Error(
      `A wait_for_trigger needs timeoutMinutes between 1 and ${WAIT_TIMEOUT_MAX_MINUTES} (${JOURNEY_LIMITS.waitDays} days)`,
    );
  }

  // Default TRUE, matching HA: only an explicit `false` stops the run. Written
  // as `!== false` rather than `=== true` so a config that predates the flag,
  // or omits it, gets the documented default instead of the strict one.
  return { triggers, timeoutMinutes, continueOnTimeout: config.continueOnTimeout !== false };
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
  passed: boolean;
};

/**
 * The per-clause result behind a condition's verdict.
 *
 * "Condition did not match" is true and useless: it sends someone re-reading
 * every clause by hand against a lead whose values have since changed. This
 * records what each clause actually compared, so the trace answers the question
 * instead of posing it. Home Assistant's trace does the same thing — its graph
 * highlights the path taken and each node carries its own result.
 *
 * Nested groups are flattened: the field/operator pairs are what a reader is
 * looking for, and the group structure is already visible in the builder.
 */
export function explainConditions(
  group: JourneyConditionGroup | null,
  context: Record<string, unknown>
): ConditionExplanation[] {
  if (!group) return [];
  return group.conditions.flatMap((condition) => {
    if ("conditions" in condition) return explainConditions(condition, context);
    const actual = valueAtPath(context, condition.field);
    return [{
      field: condition.field,
      operator: condition.operator,
      expected: condition.value,
      actual,
      passed: compare(condition, actual),
    }];
  });
}

export function evaluateConditions(
  group: JourneyConditionGroup | null,
  context: Record<string, unknown>
): boolean {
  if (!group || group.conditions.length === 0) return true;
  const results = group.conditions.map((condition) =>
    "conditions" in condition
      ? evaluateConditions(condition, context)
      : compare(condition, valueAtPath(context, condition.field))
  );
  return group.logic === "or" ? results.some(Boolean) : results.every(Boolean);
}

export function stepById(definition: JourneyDefinition, id: string | null | undefined) {
  return id ? definition.steps.find((step) => step.id === id) ?? null : null;
}
