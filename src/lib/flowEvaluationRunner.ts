import "server-only";
import { runFlow, type Flow, type FlowInput, type FlowSession, type OutMsg } from "./flow";
import { flowRuntimeVars } from "./flowSession";
import {
  isEvaluationExpectation,
  isEvaluationTurn,
  type FlowEvaluationExpectation,
  type FlowEvaluationOutcome,
  type FlowEvaluationTurn,
} from "./flowEvaluationContract";

export type FlowEvaluationResult = {
  passed: boolean;
  outcome: FlowEvaluationOutcome;
  reasons: string[];
  replyExcerpt: string;
  finalNodeId: string | null;
  variables: Record<string, string>;
  trace: string[];
};

export function parseEvaluationFlow(definition: string): Flow | null {
  try {
    const parsed = JSON.parse(definition);
    return parsed?.start && parsed?.nodes?.[parsed.start] ? parsed as Flow : null;
  } catch {
    return null;
  }
}

function outputText(messages: OutMsg[]): string {
  return messages.map((message) => message.type === "image" ? message.caption ?? "" : message.text).filter(Boolean).join("\n");
}

function pickChoice(messages: OutMsg[], label: string): string | null {
  const wanted = label.trim().toLocaleLowerCase();
  for (const message of [...messages].reverse()) {
    if (message.type !== "choice") continue;
    const option = message.options.find((item) => item.label.trim().toLocaleLowerCase() === wanted);
    if (option) return option.id;
  }
  return null;
}

export async function evaluateFlowScenario(input: {
  flow: Flow;
  channel?: string;
  turns: unknown;
  expectation: unknown;
}): Promise<FlowEvaluationResult> {
  const turns = Array.isArray(input.turns) && input.turns.length <= 12 && input.turns.every(isEvaluationTurn)
    ? input.turns as FlowEvaluationTurn[]
    : null;
  const expectation = isEvaluationExpectation(input.expectation)
    ? input.expectation as FlowEvaluationExpectation
    : null;
  if (!turns?.length || !expectation) throw new Error("Evaluation data is malformed.");

  const fixedNow = new Date("2030-01-15T07:00:00.000Z");
  let session: FlowSession | null = { nodeId: null, vars: { greeting: "Hi there 👋", first_name: "Test", name: "Test", ...flowRuntimeVars(input.channel ?? "whatsapp", fixedNow) } };
  let handedOff = false;
  let variables: Record<string, string> = session.vars;
  let lastMessages: OutMsg[] = [];
  const replies: string[] = [];
  const trace: string[] = [];

  async function runTurn(turn: FlowInput, label: string) {
    if (!session) throw new Error(`The flow ended before ${label}.`);
    trace.push(`Input: ${label}`);
    const currentSession = session;
    const result = await runFlow(input.flow, currentSession, turn, {
      dynamicAnswer: async (source) => source === "colours"
        ? "Available colours (evaluation fixture): Arctic White, Midnight Black."
        : "Current range (evaluation fixture): City E-Bike — R29,999; Commuter E-Bike — R39,999.",
      aiReply: async () => ({ reply: "[Evaluation] Simulated AI answer from the deterministic flow suite.", handoff: false }),
      availableSlots: async () => [{ id: "2030-01-15_09:00", label: "Tue 15 Jan · 09:00 (simulated)" }],
      bookSlot: async (slotId, vars, nodeId) => { trace.push(`CRM: node ${nodeId} would reserve ${slotId}`); vars.slot = slotId; return { ok: true, label: slotId }; },
      rescheduleSlot: async (slotId, vars, nodeId) => { trace.push(`CRM: node ${nodeId} would reschedule to ${slotId}`); vars.booking_rescheduled = "yes"; return { ok: true, label: slotId }; },
      manageBooking: async (action, vars, nodeId) => {
        trace.push(`CRM: node ${nodeId} would ${action} a booking`);
        if (action === "lookup") { vars.booking_identity = "verified"; vars.booking_found = "yes"; vars.booking_id = "simulated-activity-id"; return { ok: true }; }
        vars.booking_cancelled = vars.booking_id ? "yes" : "no";
        return { ok: Boolean(vars.booking_id) };
      },
      startJourney: async (journeyId, vars, nodeId) => { trace.push(`Journey: node ${nodeId} would enrol in ${journeyId}`); vars.journey_started = "yes"; return { ok: true }; },
      createBooking: async (_vars, action, nodeId) => { trace.push(`CRM: node ${nodeId} would create ${action ?? "service"}`); return { ok: true }; },
      handoff: async () => { trace.push("Handoff: would pause bot and notify team"); },
    });
    session = result.session;
    variables = result.session?.vars ?? currentSession.vars;
    handedOff = result.handedOff;
    lastMessages = result.messages;
    replies.push(outputText(result.messages));
    trace.push(result.handedOff ? "Stop: handed off" : result.session?.nodeId ? `Wait: ${result.session.nodeId}` : "Stop: completed");
  }

  await runTurn({ text: "" }, "start");
  for (const [index, turn] of turns.entries()) {
    if (!session) throw new Error(`The flow ended before saved turn ${index + 1}.`);
    if (turn.kind === "choice") {
      const choiceId = pickChoice(lastMessages, turn.value);
      if (!choiceId) throw new Error(`Saved choice “${turn.value}” was not offered at turn ${index + 1}.`);
      await runTurn({ text: turn.value, choiceId }, `choice: ${turn.value}`);
    } else if (turn.kind === "file") {
      await runTurn({ text: `[file: ${turn.value}]`, fileUrl: `https://evaluation.invalid/${encodeURIComponent(turn.value)}` }, `file: ${turn.value}`);
    } else {
      await runTurn({ text: turn.value }, turn.value);
    }
  }

  const outcome: FlowEvaluationOutcome = handedOff ? "handoff" : session ? "waiting" : "completed";
  const finalVariables = variables;
  const replyText = replies.filter(Boolean).join("\n");
  const reasons: string[] = [];
  if (outcome !== expectation.outcome) reasons.push(`Expected ${expectation.outcome}; got ${outcome}.`);
  if (expectation.replyContains && !replyText.toLocaleLowerCase().includes(expectation.replyContains.toLocaleLowerCase())) {
    reasons.push(`Reply did not contain “${expectation.replyContains}”.`);
  }
  if (expectation.variable && finalVariables[expectation.variable.key] !== expectation.variable.value) {
    reasons.push(`Expected {{${expectation.variable.key}}} = “${expectation.variable.value}”; got “${finalVariables[expectation.variable.key] ?? "missing"}”.`);
  }

  return {
    passed: reasons.length === 0,
    outcome,
    reasons,
    replyExcerpt: replyText.slice(0, 1000),
    finalNodeId: session?.nodeId ?? null,
    variables: expectation.variable ? { [expectation.variable.key]: finalVariables[expectation.variable.key] ?? "" } : {},
    trace: trace.slice(-40),
  };
}
