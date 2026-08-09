import "server-only";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import type { Flow } from "./flow";
import { validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

export type GeneratedFlowDraft = {
  flow: Flow & { positions?: Record<string, { x: number; y: number }> };
  issues: FlowIssue[];
};
export type FlowAiJourneyOption = { id: string; name: string };

function strictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
function compactExisting(definition: string): string { return definition.length <= 18_000 ? definition : definition.slice(0, 18_000); }

/** Pure draft generator: no DB writes, no publication path. */
export async function generateFlowDraft(input: {
  instruction: string;
  currentDefinition: string;
  channels: FlowChannel[];
  journeys?: FlowAiJourneyOption[];
}): Promise<GeneratedFlowDraft | null> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const instruction = input.instruction.trim().slice(0, 3000);
  if (!instruction) return null;
  const journeys = input.journeys ?? [];
  const journeyList = journeys.length
    ? journeys.map((journey) => `[${journey.id}] ${journey.name}`).join("\n")
    : "(No active Journeys are available. Do not create a journey node.)";

  const system = `You design DRAFT conversation graphs for DenagoCRM. Return exactly one JSON object and nothing else.

The output shape is:
{"start":"node_id","nodes":{"node_id":{...}},"positions":{"node_id":{"x":0,"y":0}}}

Allowed node types and fields:
- message: {id,type:"message",text,next?}
- choice: {id,type:"choice",text,options:[{id,label,description?,next?}]}
- capture: {id,type:"capture",text,variable,format?:"text"|"email"|"phone"|"number"|"date",next?}
- captureFile: {id,type:"captureFile",text,variable,next?}
- image: {id,type:"image",url,caption?,next?}
- answer: {id,type:"answer",text?,answerSource?:"pricelist"|"colours",next?}
- booking: {id,type:"booking",action?:"service"|"demo"|"lead"|"lookup"|"cancel",text?,next?}
- slots: {id,type:"slots",action?:"book"|"reschedule",text,noneText?,next?}
- journey: {id,type:"journey",journeyId:"<one ACTIVE JOURNEY id below>",text?,next?}
- condition: {id,type:"condition",condition:{variable,operator:"equals"|"not_equals"|"contains"|"exists"|"empty",value?},trueNext?,falseNext?}
- ai: {id,type:"ai",handoffNext?}
- handoff: {id,type:"handoff",text?}
- end: {id,type:"end"}

ACTIVE JOURNEYS — the ONLY journeyId values you may use:
${journeyList}

Built-in variables: greeting, first_name, name, known, slot, channel, current_date, current_time.
Booking lookup: booking_found, booking_id, booking_slot, booking_summary.
Booking cancellation: booking_cancelled. Successful reschedule: booking_slot, booking_rescheduled.
Start Journey: journey_started, journey_reason, journey_run_id.
Captured variables become available after their capture node.

Rules:
- Every node object's id MUST equal its key in nodes.
- Use only allowed node types/actions. Do not invent email/SMS/webhook/code/wait nodes.
- Flow is real-time. Long waits, scheduled messages, drips and delayed follow-ups belong in an existing Journey selected by journeyId.
- A journey node may use ONLY an id from ACTIVE JOURNEYS above. Never invent, alter or infer an id from a Journey name.
- If no active Journey can satisfy a requested delayed workflow, use a handoff or preserve the current graph; do not invent scheduling in Flow.
- CRM writes happen only through booking(service|demo|lead|cancel), slots(book|reschedule), and explicit journey enrolment. booking(lookup) is read-only.
- For cancel/reschedule, run booking(action="lookup") first and branch on booking_found before using booking_id.
- slots(action="reschedule") atomically moves the existing Activity; never model “book new then cancel old”.
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
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 5000, system, messages: [{ role: "user", content: "Return the complete replacement draft graph now." }] }),
    });
    if (!res.ok) {
      await logError("bot-flow-ai-draft", `Anthropic ${res.status}`, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    const json = await res.json();
    void recordAiUsage(json.usage);
    const parsed = strictJsonObject(String(json.content?.[0]?.text ?? ""));
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
    return { flow, issues: validateFlow(flow, input.channels) };
  } catch (error) {
    await logError("bot-flow-ai-draft", error).catch(() => {});
    return null;
  }
}
