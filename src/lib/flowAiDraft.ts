import "server-only";
import { logError } from "./errorLog";
import { aiText } from "./aiText";
import type { Flow } from "./flow";
import { validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";
import { aiDraftIssues, aiNodeGuide, aiRefsGuide, withAiRefLabels, type FlowAiRefs } from "./flowAiNodes";

export type GeneratedFlowDraft = {
  flow: Flow & { positions?: Record<string, { x: number; y: number }> };
  issues: FlowIssue[];
};

function strictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function compactExisting(definition: string): string { return definition.length <= 18_000 ? definition : definition.slice(0, 18_000); }
function previousFlow(definition: string): Flow | null {
  const parsed = strictJsonObject(definition);
  return parsed?.nodes && typeof parsed.nodes === "object" ? parsed as unknown as Flow : null;
}

/** Pure draft generator: no DB writes, no publication path. */
export async function generateFlowDraft(input: {
  instruction: string;
  currentDefinition: string;
  channels: FlowChannel[];
  /** What the draft may point at — this workspace's own records (lib/flowAiNodes). */
  refs: FlowAiRefs;
  /** Names of the workspace's shared values ({{name}} in any text). */
  sharedNames?: string[];
}): Promise<GeneratedFlowDraft | null> {
  const instruction = input.instruction.trim().slice(0, 3000);
  if (!instruction) return null;
  const journeys = input.refs.journeys;
  const journeyList = journeys.length
    ? journeys.map((journey) => `[${journey.id}] ${journey.name}`).join("\n")
    : "(No active Journeys are available. Do not create a journey node.)";

  const system = `You design DRAFT conversation graphs for a business's customer chatbot. Return exactly one JSON object and nothing else.

The output shape is:
{"start":"node_id","nodes":{"node_id":{...}},"onFailure?":"node_id","positions":{"node_id":{"x":0,"y":0}}}
"onFailure" (optional) is the step any failed action goes to when it has no failure route of its own.

Allowed node types and fields:
${aiNodeGuide()}

ACTIVE JOURNEYS — the ONLY journeyId values you may use:
${journeyList}

The ONLY ids you may use for the other steps that point at a record — never invent, alter or infer one from a name:
${aiRefsGuide(input.refs)}

Built-in variables: greeting, first_name, name, known, slot, channel, current_date, current_time, booking_identity.
Booking lookup: booking_found, booking_id, booking_slot, booking_summary.
Booking cancellation: booking_cancelled. Successful reschedule: booking_slot, booking_rescheduled.
Start Journey: journey_started, journey_reason, journey_run_id.
Shared values (the business's own, usable as {{name}}): ${(input.sharedNames ?? []).slice(0, 60).join(", ") || "(none)"}.
Captured, set, extracted and saved (saveAs) variables become available after their step.

Rules:
- Every node object's id MUST equal its key in nodes.
- Use only the allowed node types/actions. Do not invent email/SMS/code nodes.
- Flow is real-time. delay is only a short pause inside the conversation; noReply follows up an unanswered question. Long waits, scheduled messages, drips and delayed follow-ups belong in an existing Journey selected by journeyId (use its "after" to start it later).
- A journey node may use ONLY an id from ACTIVE JOURNEYS above. Never invent, alter or infer an id from a Journey name.
- If no active Journey can satisfy a requested delayed workflow, use a handoff or preserve the current graph; do not invent scheduling in Flow.
- CRM writes happen only through booking(service|demo|lead|cancel), slots(book|reschedule), crm(tag|assign|stage), and explicit journey enrolment. booking(lookup) is read-only.
- An http step calls ONLY a listed connection, on that connection's host. With no connection listed, use handoff instead.
- Every fallible booking, slots, journey, crm, http, extract or subflow action needs an honest failure route. Use failureText/failureNext; use unavailableNext only for a valid request with no capacity.
- For cancel/reschedule, run booking(action="lookup") first and branch on booking_found before using booking_id.
- slots(action="reschedule") atomically moves the existing Activity; never model “book new then cancel old”.
- Use handoff when the requested action is unsupported.
- Do not invent URLs, prices, policies, specs or facts. Use answerSource for live price/colour lists and ai for open questions.
- Prefer menu labels <=20 characters and <=10 options.
- Avoid automatic cycles. Waiting nodes (choice/capture/captureFile/slots/ai) are fine.
- Preserve useful existing behaviour unless the instruction clearly asks to replace it.
- This is a DRAFT. Never claim it is published or live.

CURRENT SAVED DRAFT:
${compactExisting(input.currentDefinition)}

OWNER INSTRUCTION:
${instruction}`;

  try {
    // A whole graph is a big answer: ChatGPT gets a minute, at medium effort.
    const answer = await aiText({ scope: "bot-flow-ai-draft", system, prompt: "Return the complete replacement draft graph now.", maxTokens: 5000, timeoutMs: 60_000, effort: "medium" });
    if (!answer.ok) return null;
    const parsed = strictJsonObject(answer.text);
    if (!parsed?.start || !parsed?.nodes || typeof parsed.nodes !== "object") {
      await logError("bot-flow-ai-draft", "Generated flow was outside the required graph contract").catch(() => {});
      return null;
    }
    const flow = parsed as unknown as GeneratedFlowDraft["flow"];
    const allowedJourneyIds = new Set(journeys.map((journey) => journey.id));
    for (const node of Object.values(flow.nodes)) {
      if (node?.type === "journey" && !allowedJourneyIds.has(node.journeyId)) {
        return { flow, issues: [{ severity: "error", code: "journey.ai_unapproved", message: "AI draft referenced a Journey that was not in the active allow-list.", nodeId: node.id }] };
      }
    }
    // Every other record a new or changed step points at must be on its list (lib/flowAiNodes).
    const refused = aiDraftIssues(flow, previousFlow(input.currentDefinition), input.refs);
    if (refused.length) return { flow, issues: refused };
    withAiRefLabels(flow, input.refs);
    return { flow, issues: validateFlow(flow, input.channels) };
  } catch (error) {
    await logError("bot-flow-ai-draft", error).catch(() => {});
    return null;
  }
}
