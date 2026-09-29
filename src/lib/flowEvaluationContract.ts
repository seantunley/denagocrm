export const FLOW_EVALUATION_MAX_TURNS = 12;
export const FLOW_EVALUATION_MAX_TURN_LENGTH = 240;

export type FlowEvaluationTurn = { kind: "text" | "choice" | "file"; value: string };
export type FlowEvaluationOutcome = "completed" | "handoff" | "waiting";
export type FlowEvaluationExpectation = {
  outcome: FlowEvaluationOutcome;
  replyContains?: string;
  variable?: { key: string; value: string };
};

export function parseEvaluationTurns(value: string): FlowEvaluationTurn[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("Add at least one customer turn.");
  if (lines.length > FLOW_EVALUATION_MAX_TURNS) throw new Error(`Use no more than ${FLOW_EVALUATION_MAX_TURNS} turns.`);

  return lines.map((line, index) => {
    const match = line.match(/^(text|choice|file)\s*:\s*(.+)$/i);
    const kind = (match?.[1]?.toLowerCase() ?? "text") as FlowEvaluationTurn["kind"];
    const turnValue = (match?.[2] ?? line).trim();
    if (!turnValue) throw new Error(`Turn ${index + 1} has no value.`);
    if (turnValue.length > FLOW_EVALUATION_MAX_TURN_LENGTH) {
      throw new Error(`Turn ${index + 1} exceeds ${FLOW_EVALUATION_MAX_TURN_LENGTH} characters.`);
    }
    return { kind, value: turnValue };
  });
}

export function parseEvaluationExpectation(input: {
  outcome?: string;
  replyContains?: string;
  variableKey?: string;
  variableValue?: string;
}): FlowEvaluationExpectation {
  const outcome = input.outcome as FlowEvaluationOutcome;
  if (!(["completed", "handoff", "waiting"] as string[]).includes(outcome)) {
    throw new Error("Choose an expected final outcome.");
  }
  const replyContains = input.replyContains?.trim().slice(0, 240);
  const variableKey = input.variableKey?.trim().replace(/\W/g, "").slice(0, 80);
  const variableValue = input.variableValue?.trim().slice(0, 240);
  if ((variableKey && !variableValue) || (!variableKey && variableValue)) {
    throw new Error("Variable key and expected value must be supplied together.");
  }
  return {
    outcome,
    ...(replyContains ? { replyContains } : {}),
    ...(variableKey && variableValue ? { variable: { key: variableKey, value: variableValue } } : {}),
  };
}

export function isEvaluationTurn(value: unknown): value is FlowEvaluationTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<FlowEvaluationTurn>;
  return ["text", "choice", "file"].includes(turn.kind ?? "")
    && typeof turn.value === "string"
    && turn.value.length > 0
    && turn.value.length <= FLOW_EVALUATION_MAX_TURN_LENGTH;
}

export function isEvaluationExpectation(value: unknown): value is FlowEvaluationExpectation {
  if (!value || typeof value !== "object") return false;
  const expectation = value as Partial<FlowEvaluationExpectation>;
  if (!["completed", "handoff", "waiting"].includes(expectation.outcome ?? "")) return false;
  if (expectation.replyContains !== undefined && (typeof expectation.replyContains !== "string" || expectation.replyContains.length > 240)) return false;
  if (expectation.variable !== undefined) {
    if (!expectation.variable || typeof expectation.variable !== "object") return false;
    if (typeof expectation.variable.key !== "string" || !expectation.variable.key || expectation.variable.key.length > 80) return false;
    if (typeof expectation.variable.value !== "string" || !expectation.variable.value || expectation.variable.value.length > 240) return false;
  }
  return true;
}
