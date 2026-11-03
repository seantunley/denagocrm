import { runFlow, type ContactCard, type Flow, type FlowCtx, type FlowInput, type FlowSession, type OutMsg } from "./flow";
import { voiceNoteTranscript } from "./voiceNoteReply";

/**
 * The replay itself, with no database: the production engine, fed what the webhook fed it, every effect stubbed.
 * lib/flowReplay loads the conversation; this runs it.
 */

/** `assumed`: what this step's result depended on that a replay cannot know (an AI, a live API…) — the path after it is a guess. */
export type ReplayStep = { order: number; turn: number; nodeId: string; changed: Record<string, string>; assumed?: string };
export type ReplayTurn = { turn: number; customer: string; bot: string[] };
export type ReplayRun = {
  steps: ReplayStep[];
  turns: ReplayTurn[];
  finalVars: Record<string, string>;
  ended: "waiting" | "handed off" | "finished";
  /** Where the replay stopped to wait after each turn (null once it ended) — checked against the recorded waits. */
  waits: (string | null)[];
};

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
 * `recordedByTurn`: per customer message (turn, from 1), the steps whose CRM action the real conversation recorded IN
 * that turn (only successes are recorded — flowRun/flowSession). An action succeeds here only if it did in the same
 * turn then, so a failed first try and a later success at the same step are told apart (PR #974 review).
 *
 * Anything the replay cannot know — an AI answer or routing, a knowledge search, an API call, reading values out of a
 * message, which booking slots were free — is NOT presented as what happened: the step is marked `assumed`, and the
 * loader (lib/flowReplay) checks the replayed path against the waits the real conversation recorded.
 */
export async function replayMessages(
  flow: Flow,
  bodies: string[],
  opts: { vars: Record<string, string>; recordedByTurn: ReadonlyMap<number, ReadonlySet<string>>; loadSubflow?: FlowCtx["loadSubflow"] },
): Promise<ReplayRun> {
  const steps: ReplayStep[] = [];
  const turns: ReplayTurn[] = [];
  const waits: (string | null)[] = [];
  let seen: Record<string, string> = {};
  let turn = 0;
  const outcome = (nodeId: string) => (opts.recordedByTurn.get(turn)?.has(nodeId) ? { ok: true } : { ok: false, reason: "not recorded in the real conversation" });
  /** Mark the step running now as a guess. */
  const assume = (what: string) => { const step = steps.at(-1); if (step && !step.assumed) step.assumed = what; };
  const ctx: FlowCtx = {
    onStep: (nodeId, vars) => {
      steps.push({ order: steps.length + 1, turn, nodeId, changed: Object.fromEntries(Object.entries(vars).filter(([k, v]) => !hidden(k) && seen[k] !== v)) });
      seen = { ...vars };
    },
    dynamicAnswer: async (source) => `[${source === "colours" ? "colour list" : "price list"}]`,
    aiReply: async () => { assume("the AI's answer"); return { reply: "[AI answer — not re-asked in a replay]", handoff: false }; },
    routeChoice: async () => { assume("which option the AI read the customer's words as"); return null; },
    knowledgeAnswer: async () => { assume("the knowledge search result"); return { ok: true, text: "[Knowledge answer — not re-asked in a replay]" }; },
    extractData: async () => { assume("the values read from the message"); return { ok: true, values: {} }; },
    httpRequest: async () => { assume("the API's reply"); return { ok: true, status: 200, body: "" }; },
    handoff: async () => {},
    createBooking: async (_vars, _action, nodeId) => outcome(nodeId),
    manageBooking: async (_action, _vars, nodeId) => outcome(nodeId),
    startJourney: async (_journeyId, _vars, nodeId) => outcome(nodeId),
    availableSlots: async () => { assume("which booking slots were free"); return []; },
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
    waits.push(session?.nodeId ?? null);
    if (result.handedOff) ended = "handed off";
    else if (!session) ended = "finished";
  }
  const last = session?.vars ?? seen;
  return { steps, turns, finalVars: Object.fromEntries(Object.entries(last).filter(([k]) => !hidden(k))), ended, waits };
}

/** Consecutive repeats collapsed: a re-asked question is one wait in the record. */
const collapse = (ids: (string | null)[]) => ids.filter((id): id is string => Boolean(id)).filter((id, i, all) => i === 0 || all[i - 1] !== id);

/**
 * Does the replayed path agree with what was RECORDED (BotFlowEvent node_waiting, written by the session trigger, and
 * how the conversation ended)? Agreement is the only thing that lets the canvas be read as what happened.
 */
export function checkReplay(run: Pick<ReplayRun, "waits" | "ended">, recordedWaits: string[], recordedEnd: "handed off" | "finished" | null): { matches: boolean; text: string } {
  const replayed = collapse(run.waits);
  const real = collapse(recordedWaits);
  const differ = replayed.findIndex((id, i) => real[i] !== id);
  if (differ !== -1 || replayed.length < real.length) {
    const at = differ === -1 ? replayed.length : differ;
    return { matches: false, text: `Differs from what was recorded at stop ${at + 1}: the real conversation ${real[at] ? "waited somewhere else" : "did not wait there"}. Read the path from there on as a reconstruction, not what happened.` };
  }
  if (replayed.length > real.length) return { matches: false, text: `Waits more often than the real conversation did (${replayed.length} vs ${real.length}). Read the later steps as a reconstruction.` };
  if (recordedEnd && run.ended !== recordedEnd) return { matches: false, text: `The real conversation ${recordedEnd === "handed off" ? "was handed to the team" : "finished"}; the replay ${run.ended === "waiting" ? "is still waiting" : run.ended === "handed off" ? "handed off" : "finished"}. Read it as a reconstruction.` };
  return { matches: true, text: `Matches the record: it stopped at the same ${real.length === 1 ? "step" : `${real.length} steps`} as the real conversation${recordedEnd ? ` and ${recordedEnd === "handed off" ? "was handed to the team" : "finished"} the same way` : ""}.` };
}
