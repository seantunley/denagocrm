import "server-only";
import { getSetting } from "./settings";
import { logError } from "./errorLog";
import { recordAiUsage } from "./systemHealth";
import type { Flow } from "./flow";
import { flowErrors, validateFlow, type FlowChannel, type FlowIssue } from "./flowValidation";

export type GeneratedFlowDraft = {
  flow: Flow & { positions?: Record<string, { x: number; y: number }> };
  issues: FlowIssue[];
};

function strictJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function compactExisting(definition: string): string {
  return definition.length <= 18_000 ? definition : definition.slice(0, 18_000);
}

/**
 * Generate a replacement DRAFT graph only. This function has no DB writes and
 * no publication path; its result must pass the same channel compiler as a
 * hand-built flow before the caller is allowed to persist it.
 */
export async function generateFlowDraft(input: {
  instruction: string;
  currentDefinition: string;
  channels: FlowChannel[];
}): Promise<GeneratedFlowDraft | null> {
  const apiKey = await getSetting("ANTHROPIC_API_KEY");
  if (!apiKey) return null;
  const instruction = input.instruction.trim().slice(0, 3000);
  if (!instruction) return null;

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
- booking: {id,type:"booking",action?:"service"|"demo"|"lead",text?,next?}
- slots: {id,type:"slots",text,noneText?,next?}
- condition: {id,type:"condition",condition:{variable,operator:"equals"|"not_equals"|"contains"|"exists"|"empty",value?},trueNext?,falseNext?}
- ai: {id,type:"ai",handoffNext?}
- handoff: {id,type:"handoff",text?}
- end: {id,type:"end"}

Built-in variables available at runtime: greeting, first_name, name, known, slot, channel, current_date, current_time. Captured variables become available after their capture node.

Rules:
- Every node object's id MUST equal its key in nodes.
- Use only the allowed node types/actions. Do not invent email/SMS/webhook/code nodes.
- CRM writes happen only through booking(service|demo|lead) and slots. Use handoff when the requested action is unsupported.
- Do not invent URLs, prices, policies, product specs or business copy the owner did not provide in the instruction/current flow. Use answerSource for live price/colour lists and ai for open questions.
- Keep menu labels concise enough for messaging channels; prefer <=20 characters and <=10 options.
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5000,
        system,
        messages: [{ role: "user", content: "Return the complete replacement draft graph now." }],
      }),
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
    const issues = validateFlow(flow, input.channels);
    if (flowErrors(issues).length) return { flow, issues };
    return { flow, issues };
  } catch (error) {
    await logError("bot-flow-ai-draft", error).catch(() => {});
    return null;
  }
}
