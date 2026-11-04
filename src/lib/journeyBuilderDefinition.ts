/**
 * The Journey builder's steps → the saved definition (components/JourneyBuilder). No server code: it runs in the browser.
 *
 * Top level: each step's nextStepId is the one below it, and a condition branches — true carries on, false goes to a
 * generated stop — unless it names its own branch targets, which are kept.
 * Inside a Choose branch or a Repeat loop: a sequence runs in order, so no step names a next step, and a condition is a
 * GATE (it stops the run when false; journeyStepControl) with no branch targets — the parser refuses both there.
 */

export type BuilderStep = {
  id: string;
  type: string;
  /** Keep going if this step fails. Round-tripped so saving cannot drop it. */
  continueOnError?: boolean;
  /** Whether this step runs. Round-tripped: a step silently re-armed by a save is a message nobody asked for. */
  enabled?: boolean;
  config: Record<string, unknown>;
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const generatedStopId = (conditionId: string) => `${conditionId}_false_stop`;

export type ConditionGroup = { logic?: string; conditions: unknown[] };
export const emptyGroup = (): ConditionGroup => ({ logic: "and", conditions: [{ field: "lead.source", operator: "equals", value: "" }] });

let idSeq = 0;
export const newStepId = () => `step_${Date.now().toString(36)}_${idSeq++}`;
export const newWaitStep = (): BuilderStep => ({ id: newStepId(), type: "wait", config: { amount: 1, unit: "days" } });

/** What a step starts with when its type is picked — always something the parser accepts, bar a text the author must type. */
export function initialConfig(type: string): Record<string, unknown> {
  if (type === "wait") return { amount: 1, unit: "days" };
  if (type === "create_activity") return { activityType: "call", dueDays: 0 };
  if (type === "condition") return { condition: emptyGroup() };
  // A mark-lost step will not SAVE without a reason (parseLeadOutcomeConfig refuses one), so the field is seeded
  // empty and visible rather than left for the author to discover on a rejected save.
  if (type === "lead_mark_lost") return { reason: "" };
  if (type === "wait_for_trigger") return { triggers: ["quote_signed"], timeoutMinutes: 3 * 1440, continueOnTimeout: true };
  if (type === "wait_for_condition") return { condition: emptyGroup(), timeoutMinutes: 3 * 1440, continueOnTimeout: true };
  if (type === "variables") return { set: { note: "" } };
  if (type === "choose") return { options: [{ conditions: emptyGroup(), sequence: [newWaitStep()] }] };
  if (type === "repeat") return { mode: "count", count: 2, sequence: [newWaitStep()] };
  return {};
}

function withNested(config: Record<string, unknown>): Record<string, unknown> {
  const out = { ...config };
  if (Array.isArray(out.sequence)) out.sequence = sequence(out.sequence);
  if (Array.isArray(out.default)) out.default = sequence(out.default);
  if (Array.isArray(out.options)) {
    out.options = out.options.map((option) => (isRecord(option) && Array.isArray(option.sequence) ? { ...option, sequence: sequence(option.sequence) } : option));
  }
  return out;
}

function sequence(steps: unknown[]): unknown[] {
  return steps.map((raw) => {
    if (!isRecord(raw)) return raw;
    const step = { ...raw, config: withNested(isRecord(raw.config) ? raw.config : {}) } as Record<string, unknown> & { config: Record<string, unknown> };
    delete step.nextStepId;
    if (step.type === "condition") {
      delete step.config.trueStepId;
      delete step.config.falseStepId;
    }
    return step;
  });
}

/**
 * A saved definition → the builder's steps (list editor and canvas alike): the saved steps minus the stops the builder
 * generated. Every step keeps ALL it carries — its name, its nested sequences, a condition's own branch targets, a type
 * this build doesn't know — because the editors change only the keys they own and the rest is saved exactly as it was.
 */
export function builderSteps(definition?: { steps?: BuilderStep[] } | null): BuilderStep[] {
  const existing = (definition?.steps ?? []).filter((step) => step.config?.systemGenerated !== true);
  if (existing.length === 0) {
    return [{ id: "step_1", type: "create_activity", config: { activityType: "call", dueDays: 0 } }];
  }
  return existing.map((step) => ({ ...step, config: { ...step.config } }));
}

export function builderDefinition(steps: BuilderStep[]) {
  const stops: BuilderStep[] = [];
  const mapped = steps.map((step, index) => {
    const nextStepId = steps[index + 1]?.id ?? null;
    const config = withNested(step.config);
    if (step.type !== "condition") return { ...step, nextStepId, config };
    const custom = Boolean(config.trueStepId || config.falseStepId) && config.falseStepId !== generatedStopId(step.id);
    if (custom) return { ...step, nextStepId, config };
    stops.push({ id: generatedStopId(step.id), type: "stop", config: { reason: "Condition did not match", systemGenerated: true } });
    return { ...step, nextStepId, config: { ...config, trueStepId: nextStepId, falseStepId: generatedStopId(step.id) } };
  });
  return { startStepId: steps[0]?.id ?? null, steps: [...mapped, ...stops.map((stop) => ({ ...stop, nextStepId: null }))] };
}
