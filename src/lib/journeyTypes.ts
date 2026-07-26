import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationTrigger,
} from "./automationCatalog";

export const JOURNEY_TRIGGERS = AUTOMATION_TRIGGERS.map((trigger) => trigger.value) as readonly AutomationTrigger[];
export type JourneyTrigger = AutomationTrigger;

export const JOURNEY_STEP_TYPES = AUTOMATION_ACTIONS.map((action) => action.value) as readonly AutomationAction[];
export type JourneyStepType = AutomationAction;

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
  "event.entityType",
  "event.sourceId",
  "event.status",
  "event.priority",
  "event.branch",
  "event.daysUntilExpiry",
  "event.hoursOverdue",
  "event.stage",
  "event.previousStage",
  "event.outcome",
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number] | `event.${string}` | `source.${string}`;
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
  nextStepId?: string | null;
  config: Record<string, unknown>;
};

export type JourneyDefinition = {
  startStepId: string | null;
  steps: JourneyStep[];
};

const STEP_TYPES = new Set<string>(JOURNEY_STEP_TYPES);
const FIELDS = new Set<string>(CONDITION_FIELDS);
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

function supportedConditionField(field: string): field is ConditionField {
  if (FIELDS.has(field)) return true;
  return /^(event|source)\.[a-zA-Z0-9_.-]{1,120}$/.test(field);
}

export function parseConditionGroup(value: unknown): JourneyConditionGroup | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new Error("Conditions must be an object");
  const logic = value.logic === "or" ? "or" : "and";
  if (!Array.isArray(value.conditions)) throw new Error("Conditions must contain a list");
  if (value.conditions.length > 30) throw new Error("A journey may contain at most 30 conditions");

  const conditions = value.conditions.map((condition) => {
    if (!isRecord(condition)) throw new Error("Invalid journey condition");
    if (Array.isArray(condition.conditions)) {
      const nested = parseConditionGroup(condition);
      if (!nested) throw new Error("Invalid nested condition group");
      return nested;
    }
    const field = String(condition.field ?? "");
    const operator = String(condition.operator ?? "");
    if (!supportedConditionField(field)) throw new Error(`Unsupported condition field: ${field}`);
    if (!OPERATORS.has(operator)) throw new Error(`Unsupported condition operator: ${operator}`);
    return {
      field,
      operator: operator as ConditionOperator,
      value: condition.value,
    };
  });

  return { logic, conditions };
}

export function parseJourneyDefinition(value: unknown): JourneyDefinition {
  if (!isRecord(value)) throw new Error("Journey definition must be an object");
  if (!Array.isArray(value.steps)) throw new Error("Journey definition must contain steps");
  if (value.steps.length > 50) throw new Error("A journey may contain at most 50 steps");

  const seen = new Set<string>();
  const steps: JourneyStep[] = value.steps.map((raw) => {
    if (!isRecord(raw)) throw new Error("Invalid journey step");
    const id = cleanId(raw.id);
    if (!id) throw new Error("Each step needs a safe unique ID");
    if (seen.has(id)) throw new Error(`Duplicate step ID: ${id}`);
    seen.add(id);
    const type = String(raw.type ?? "");
    if (!STEP_TYPES.has(type)) throw new Error(`Unsupported journey step: ${type}`);
    const nextStepId = raw.nextStepId == null || raw.nextStepId === "" ? null : cleanId(raw.nextStepId);
    if (raw.nextStepId && !nextStepId) throw new Error(`Invalid next step for ${id}`);
    const config = isRecord(raw.config) ? raw.config : {};
    return {
      id,
      type: type as JourneyStepType,
      name: typeof raw.name === "string" ? raw.name.slice(0, 120) : undefined,
      nextStepId,
      config,
    };
  });

  const startStepId = value.startStepId == null ? null : cleanId(value.startStepId);
  if (value.startStepId && !startStepId) throw new Error("Invalid starting step");
  if (startStepId && !seen.has(startStepId)) throw new Error("Starting step does not exist");

  for (const step of steps) {
    if (step.nextStepId && !seen.has(step.nextStepId)) {
      throw new Error(`Step ${step.id} points to a missing next step`);
    }
    if (step.type === "condition") {
      parseConditionGroup(step.config.condition);
      for (const key of ["trueStepId", "falseStepId"] as const) {
        const target = step.config[key];
        if (target != null && target !== "") {
          const clean = cleanId(target);
          if (!clean || !seen.has(clean)) throw new Error(`Condition ${step.id} has an invalid ${key}`);
        }
      }
    }
  }

  return { startStepId, steps };
}

function valueAtPath(context: Record<string, unknown>, path: string): unknown {
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
