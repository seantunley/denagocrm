import type { Flow, FlowCtx, FlowNode, FlowSession, NoReply } from "./flow";

/**
 * WAIT FOR A REPLY, ELSE… (Node-RED's trigger node; Sean, 2026-11-04): a question can say "if they don't answer within
 * 30 minutes, go here" — a nudge, or another branch. Pure rules; the WhatsApp runner arms the deadline after each turn
 * and the no-reply sweep — inside the 30-minute bot-outbox run, because a faster job of its own would roughly double the
 * time the database is awake (tests/cronScheduleCost) — moves conversations whose deadline passed, so a move lands up to
 * 30 minutes after its deadline.
 *
 * WHATSAPP'S 24-HOUR RULE: the bot may only write while 24 hours have not passed since the CUSTOMER's last message. A
 * deadline is therefore never set later than 23½ hours after it — so a nudge that waits again cannot chain past the
 * window. Times are epoch milliseconds, kept in the session's hidden values.
 */
export const NO_REPLY_AT = "__noreply_at";
export const NO_REPLY_NODE = "__noreply_node";
/**
 * CLAIMED (PR #988 review): the sweep takes a timeout BEFORE running anything — the deadline is swapped for this
 * marker (= the deadline it claimed) and NO_REPLY_CLAIMED_AT (when), in one locked transaction (botSessionStore
 * claimNoReplyTx). A customer turn clears both (armNoReply), so the sweep's final fence then drops its reply. A claim
 * older than NO_REPLY_RECLAIM_MS that never finished (a crash) can be claimed again; the steps it runs carry the same
 * timeout identity (noReplyEventId), so nothing is done twice.
 */
export const NO_REPLY_CLAIMED = "__noreply_claimed";
export const NO_REPLY_CLAIMED_AT = "__noreply_claimed_at";
export const NO_REPLY_RECLAIM_MS = 10 * 60_000;
/** What a customer's message cancels (a pending deadline and any claim) — botSessionStore cancelNoReplyTx. */
export const NO_REPLY_KEYS = [NO_REPLY_AT, NO_REPLY_CLAIMED, NO_REPLY_CLAIMED_AT] as const;
export const LAST_INBOUND = "__last_inbound_at";
/** The sweep rides the 30-minute bot-outbox run (tests/cronScheduleCost: the interval is the bill), so a shorter wait means nothing. */
export const NO_REPLY_MIN_MINUTES = 30;
export const NO_REPLY_MAX_MINUTES = 23 * 60;
const WINDOW_MS = 23.5 * 3_600_000;

/** A question's "no reply" setting, if it has a usable one. */
export function noReplyOf(node: FlowNode | undefined): NoReply | null {
  if (!node || (node.type !== "choice" && node.type !== "capture" && node.type !== "captureFile") || !node.noReply?.next) return null;
  const minutes = Math.round(Number(node.noReply.minutes));
  return minutes >= NO_REPLY_MIN_MINUTES && minutes <= NO_REPLY_MAX_MINUTES ? { minutes, next: node.noReply.next } : null;
}

/**
 * The session's hidden values after a turn: a deadline for the question it now waits on (if that question has one
 * and it fits in WhatsApp's window), otherwise none. `customerWrote`: this turn was a customer's message.
 */
export function armNoReply(flow: Flow, session: FlowSession, now: number, customerWrote: boolean): Record<string, string> {
  const vars = { ...session.vars };
  if (customerWrote) vars[LAST_INBOUND] = String(now);
  delete vars[NO_REPLY_AT];
  delete vars[NO_REPLY_NODE];
  delete vars[NO_REPLY_CLAIMED];
  delete vars[NO_REPLY_CLAIMED_AT];
  const rule = session.nodeId ? noReplyOf(flow.nodes[session.nodeId]) : null;
  const lastInbound = Number(vars[LAST_INBOUND] || 0);
  if (!rule || !session.nodeId || !lastInbound) return vars;
  const at = now + rule.minutes * 60_000;
  if (at > lastInbound + WINDOW_MS) return vars; // would land outside WhatsApp's window: don't promise it
  vars[NO_REPLY_AT] = String(at);
  vars[NO_REPLY_NODE] = session.nodeId;
  return vars;
}

/**
 * The deadline this stored session is due on now, or null: a passed deadline, or a claim that never finished. Always
 * inside 24 hours of the customer's last message.
 */
export function noReplyDueAt(nodeId: string | null, vars: Record<string, string>, now: number): string | null {
  if (!nodeId || vars[NO_REPLY_NODE] !== nodeId || now >= Number(vars[LAST_INBOUND] || 0) + 24 * 3_600_000) return null;
  const at = vars[NO_REPLY_AT];
  if (at && Number(at) > 0 && Number(at) <= now) return at;
  const claimed = vars[NO_REPLY_CLAIMED];
  if (claimed && now - Number(vars[NO_REPLY_CLAIMED_AT] || 0) >= NO_REPLY_RECLAIM_MS) return claimed;
  return null;
}
export const noReplyDue = (nodeId: string | null, vars: Record<string, string>, now: number) => noReplyDueAt(nodeId, vars, now) !== null;

/**
 * THE ACTION FENCE (PR #988 reviews 2–3): a claimed timeout runs its route, and a customer can still write while it
 * does. Every step that acts outside the conversation runs through `guard`, which checks the claim and performs the
 * action AS ONE — under the conversation's lock (botSessionStore withNoReplyLock), the same lock a customer's cancel
 * takes. So a reply can't land between the check and the action: it either comes first (the claim is gone, the
 * action does nothing) or waits for that action to finish and then cancels (the next action does nothing). Once one
 * is refused, every later one is too and the runner drops the whole turn. Mutates `ctx` (built per turn).
 */
export const TIMEOUT_EFFECTS = ["createBooking", "manageBooking", "startJourney", "updateCrm", "notifyStaff", "bookSlot", "rescheduleSlot", "httpRequest", "handoff"] as const;
/** Check the claim and, only if it holds, act — atomically with respect to a customer's cancel. */
export type TimeoutGuard = <T>(act: () => Promise<T>) => Promise<{ allowed: true; value: T } | { allowed: false }>;
export function fenceTimeoutEffects(ctx: FlowCtx, guard: TimeoutGuard): { superseded: () => boolean } {
  let gone = false;
  const effects = ctx as unknown as Record<string, unknown>;
  for (const name of TIMEOUT_EFFECTS) {
    const act = effects[name];
    if (typeof act !== "function") continue;
    const refused = () => (name === "handoff" ? undefined : { ok: false, reason: "The customer replied first" });
    effects[name] = async (...args: unknown[]) => {
      if (gone) return refused();
      const outcome = await guard(async () => (act as (...a: unknown[]) => unknown)(...args));
      if (!outcome.allowed) { gone = true; return refused(); }
      return outcome.value;
    };
  }
  return { superseded: () => gone };
}

/** The timeout's own identity — the same for every attempt at the same deadline — so its steps are never done twice. */
export const noReplyEventId = (tenantId: string, key: string, nodeId: string, at: string) => `noreply:${tenantId}:${key}:${nodeId}:${at}`;
