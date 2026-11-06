import { z } from "zod";
import type { ActionCard, ProposedAction } from "./assistantActions";
import { parseActionList } from "./assistantActions";

/**
 * DAX TRIAGE — the pure half (the database half is assistantTriage.ts).
 *
 * "Find the customers waiting on us, work out what's holding each up, prepare what to do, and let me approve it":
 * one review screen for many deals, where a plan holds eight steps for one. The deals and their reasons come from the
 * Attention Centre (the same ranking the CRM shows); DAX proposes at most two tasks per deal in its usual card format;
 * the person ticks what to do. Every card still runs through the ordinary Confirm path (runAssistantAction), and a
 * message to a customer still goes only from its own Send button.
 */

export const TRIAGE_KIND = "triage";
/** Deals in one run: enough to clear a morning's backlog, small enough to read before approving. */
export const TRIAGE_MAX = 12;
export const TRIAGE_ACTIONS_PER_DEAL = 2;
/** A card left "running" longer than this died with its request: shown as unsure, never retried on its own. */
export const TRIAGE_STALE_MS = 10 * 60 * 1000;
/** Kinds triage may propose. Anything else the model writes is dropped. */
export const TRIAGE_ACTION_TYPES = ["draft_message", "follow_up", "assign", "note"] as const;

export type TriageCardStatus = "proposed" | "running" | "done" | "sent" | "failed" | "unsure" | "skipped";
export type TriageCard = {
  card: ActionCard;
  status: TriageCardStatus;
  /** What happened, as the action said it ("Follow-up booked", or why it was refused). */
  result?: string;
  claimedAt?: string;
  doneAt?: string;
};
export type TriageItem = {
  leadId: string;
  name: string;
  opportunity: string | null;
  ownerName: string | null;
  /** The Attention Centre's reasons, verbatim. */
  reasons: string[];
  /** DAX's one-line read of what's holding it up. */
  why: string | null;
  cards: TriageCard[];
};
export type TriageDetails = { items: TriageItem[]; preparedAt: string };

const card = z.object({ status: z.string(), card: z.object({ id: z.string(), kind: z.string() }).passthrough() }).passthrough();
const details = z.object({
  preparedAt: z.string(),
  items: z.array(z.object({ leadId: z.string(), name: z.string(), reasons: z.array(z.string()), cards: z.array(card) }).passthrough()),
});

/** A stored run, read defensively: a row that doesn't parse is no run. */
export function readTriage(raw: unknown): TriageDetails | null {
  const parsed = details.safeParse(raw);
  return parsed.success ? (parsed.data as unknown as TriageDetails) : null;
}

/**
 * The model's reply → per deal, its read and its proposals. Only deals it was given, only triage's kinds, only for
 * that deal (a proposal naming another lead is dropped), at most two each.
 */
export function parseTriageReply(text: string, leadIds: readonly string[]): Map<string, { why: string | null; actions: ProposedAction[] }> {
  const out = new Map<string, { why: string | null; actions: ProposedAction[] }>();
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  const deals = (parsed as { deals?: unknown })?.deals;
  if (!Array.isArray(deals)) return out;
  const allowed = new Set(leadIds);
  for (const deal of deals) {
    const leadId = typeof deal?.leadId === "string" ? deal.leadId : "";
    if (!allowed.has(leadId) || out.has(leadId)) continue;
    const actions = parseActionList(Array.isArray(deal.actions) ? deal.actions.map((a: unknown) => (a && typeof a === "object" ? { ...a, leadId } : a)) : [])
      .filter((a) => (TRIAGE_ACTION_TYPES as readonly string[]).includes(a.type))
      .slice(0, TRIAGE_ACTIONS_PER_DEAL);
    const why = typeof deal.why === "string" ? deal.why.trim().slice(0, 240) || null : null;
    out.set(leadId, { why, actions });
  }
  return out;
}

/** Customer messages go only from their own Send button — a batch never sends one. */
export const sendsToCustomer = (c: Pick<ActionCard, "kind">) => c.kind === "draft_message";

/**
 * Which ticked cards the batch may run now: proposed ones, or ones refused before they changed anything ("failed").
 * Never a send, never one done, under way or unsure.
 */
export function runnable(items: readonly TriageItem[], wanted: ReadonlySet<string>): { item: TriageItem; entry: TriageCard }[] {
  const out: { item: TriageItem; entry: TriageCard }[] = [];
  for (const item of items) for (const entry of item.cards) {
    if (wanted.has(entry.card.id) && (entry.status === "proposed" || entry.status === "failed") && !sendsToCustomer(entry.card)) out.push({ item, entry });
  }
  return out;
}

export const REPLACED_RUN = "This triage was replaced by a newer one — refresh the page and work from that.";

/**
 * Claim one card to do (or, `send`, to send): only on the CURRENT run — an older tab's run, closed when a newer one was
 * prepared, can do nothing (review of #1007) — and only a card still waiting (proposed, or refused with nothing changed).
 * Marks it running. Called under the run's row lock with the run's status as it is there.
 */
export function claimCard(
  run: TriageDetails,
  runStatus: string,
  cardId: string,
  send: boolean,
  now: Date,
): { ok: true; entry: TriageCard } | { ok: false; error: string } {
  if (runStatus !== "open") return { ok: false, error: REPLACED_RUN };
  const entry = run.items.flatMap((item) => item.cards).find((c) => c.card.id === cardId);
  if (!entry) return { ok: false, error: "That task is no longer on this triage — refresh the page." };
  if (sendsToCustomer(entry.card) !== send) return { ok: false, error: send ? "Only a message is sent." : "A message goes only from its own Send button." };
  if (entry.status !== "proposed" && entry.status !== "failed") return { ok: false, error: "That was already done or is under way." };
  entry.status = "running";
  entry.claimedAt = now.toISOString();
  return { ok: true, entry };
}

/** How a Confirm's answer becomes the card's state: refused with nothing changed can be tried again; part-way can't. */
export function statusAfter(result: { ok: boolean; unchanged?: boolean }): TriageCardStatus {
  if (result.ok) return "done";
  return result.unchanged ? "failed" : "unsure";
}

/** A card claimed and never finished: its request died. Not retried — it may have got part-way. */
export function settleStale(items: TriageItem[], now: Date): boolean {
  let changed = false;
  for (const item of items) for (const entry of item.cards) {
    if (entry.status === "running" && entry.claimedAt && now.getTime() - new Date(entry.claimedAt).getTime() > TRIAGE_STALE_MS) {
      entry.status = "unsure";
      entry.result = "This didn't finish and may have got part-way — check the deal before doing it again.";
      changed = true;
    }
  }
  return changed;
}

/** What came of a run: how many deals were acted on, and how many customers have replied since. */
export function triageOutcome(items: readonly TriageItem[], repliedSince: ReadonlySet<string>) {
  const acted = items.filter((item) => item.cards.some((c) => c.status === "done" || c.status === "sent"));
  return { acted: acted.length, replied: acted.filter((item) => repliedSince.has(item.leadId)).length };
}

export const TRIAGE_INSTRUCTIONS = [
  "You are the triage step of a sales CRM assistant. The person manages these deals; each needs attention for the reasons given.",
  "For EACH deal, say in one short line what is holding it up (\"why\"), and propose at most 2 tasks that move it forward:",
  '- draft_message: a reply to the customer, ready to send ({"type":"draft_message","channel":"whatsapp|email","subject":"<email only>","body":"...","reason":"..."}) — when the customer is waiting on us. Write it as the salesperson, warm and specific to what the customer said; never invent prices, dates or promises.',
  '- follow_up: a call or task for the deal\'s owner ({"type":"follow_up","when":"YYYY-MM-DDTHH:MM","activity":"call|whatsapp|email|meeting|todo","summary":"...","reason":"..."}) — when the next step is missing or overdue.',
  '- assign: give the deal to someone else ({"type":"assign","to":"<person, exactly as listed>","reason":"..."}) — only when the owner is missing or clearly can\'t act.',
  '- note: something the team should know ({"type":"note","text":"...","reason":"..."}).',
  "When a reason says our last message got no reply, don't send another on the same channel: propose a call (follow_up with activity \"call\") or a message on a different channel.",
  "Propose nothing for a deal that needs nothing. Use only what the deal's facts say. Times are South African, in working hours.",
  'Reply with JSON only: {"deals":[{"leadId":"<id exactly as given>","why":"...","actions":[...]}]}',
].join("\n");
