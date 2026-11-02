import { runFlow, type ContactCard, type Flow, type FlowCtx, type FlowInput, type FlowSession, type OutMsg } from "./flow";
import { voiceNoteTranscript } from "./voiceNoteReply";

/**
 * The replay itself, with no database: the production engine, fed what the webhook fed it, every effect stubbed.
 * lib/flowReplay loads the conversation; this runs it.
 */

export type ReplayStep = { order: number; turn: number; nodeId: string; changed: Record<string, string> };
export type ReplayTurn = { turn: number; customer: string; bot: string[] };
export type ReplayRun = { steps: ReplayStep[]; turns: ReplayTurn[]; finalVars: Record<string, string>; ended: "waiting" | "handed off" | "finished" };

/** What the WhatsApp webhook handed the engine, rebuilt from how the inbox logged it (webhooks/whatsapp). */
export function replayInput(body: string, flow: Flow, session: FlowSession): FlowInput {
  if (body.startsWith("👆")) {
    // A tap is logged by its title, which WhatsApp cuts to 20/24 characters (whatsapp.ts) — match the option it came from.
    const title = body.replace(/^👆\s*/u, "").trim();
    const node = session.nodeId ? flow.nodes[session.nodeId] : undefined;
    const option = node?.type === "choice" ? node.options.find((o) => o.label === title) ?? node.options.find((o) => title && o.label.startsWith(title)) : undefined;
    return option && node ? { text: title, choiceId: `${node.id}|${option.id}` } : { text: title };
  }
  if (body.startsWith("🎤")) return { text: voiceNoteTranscript(body) ?? "[The customer sent a voice note.]" };
  if (body.startsWith("📎")) {
    const caption = body.replace(/^📎\s*/u, "").trim();
    return { text: caption === "[file]" ? "" : caption, fileUrl: "[file]" };
  }
  return { text: body };
}

const shown = (m: OutMsg): string =>
  m.type === "text" ? m.text
  : m.type === "choice" ? `${m.text}  [${m.options.map((o) => o.label).join(" · ")}]`
  : m.type === "document" ? `📎 ${m.fileName ?? "document"}`
  : m.type === "image" ? "🖼 image"
  : "📇 contact card";

const hidden = (k: string) => k.startsWith("__");

/**
 * `recorded`: the steps whose CRM action the real conversation recorded (only successes are — flowRun/flowSession).
 * An action here succeeds only if it did then, so the replay takes the branch the customer actually got.
 */
export async function replayMessages(
  flow: Flow,
  bodies: string[],
  opts: { vars: Record<string, string>; recorded: ReadonlySet<string>; loadSubflow?: FlowCtx["loadSubflow"] },
): Promise<ReplayRun> {
  const steps: ReplayStep[] = [];
  const turns: ReplayTurn[] = [];
  let seen: Record<string, string> = {};
  let turn = 0;
  const outcome = (nodeId: string) => (opts.recorded.has(nodeId) ? { ok: true } : { ok: false, reason: "not recorded in the real conversation" });
  const ctx: FlowCtx = {
    onStep: (nodeId, vars) => {
      steps.push({ order: steps.length + 1, turn, nodeId, changed: Object.fromEntries(Object.entries(vars).filter(([k, v]) => !hidden(k) && seen[k] !== v)) });
      seen = { ...vars };
    },
    dynamicAnswer: async (source) => `[${source === "colours" ? "colour list" : "price list"}]`,
    aiReply: async () => ({ reply: "[AI answer — not re-asked in a replay]", handoff: false }),
    knowledgeAnswer: async () => ({ ok: true, text: "[Knowledge answer — not re-asked in a replay]" }),
    extractData: async () => ({ ok: true, values: {} }),
    httpRequest: async () => ({ ok: true, status: 200, body: "" }),
    handoff: async () => {},
    createBooking: async (_vars, _action, nodeId) => outcome(nodeId),
    manageBooking: async (_action, _vars, nodeId) => outcome(nodeId),
    startJourney: async (_journeyId, _vars, nodeId) => outcome(nodeId),
    availableSlots: async () => [],
    contactCard: async () => ({ name: "[contact card]", phones: [] }) satisfies ContactCard,
    loadSubflow: opts.loadSubflow,
  };

  let session: FlowSession | null = { nodeId: null, vars: { ...opts.vars } };
  let ended: ReplayRun["ended"] = "waiting";
  for (const body of bodies) {
    if (!session) break;
    turn += 1;
    const input = replayInput(body, flow, session);
    const result = await runFlow(flow, session, input, ctx);
    turns.push({ turn, customer: input.text || (input.fileUrl ? "[file]" : ""), bot: result.messages.map(shown) });
    session = result.session;
    if (result.handedOff) ended = "handed off";
    else if (!session) ended = "finished";
  }
  const last = session?.vars ?? seen;
  return { steps, turns, finalVars: Object.fromEntries(Object.entries(last).filter(([k]) => !hidden(k))), ended };
}
