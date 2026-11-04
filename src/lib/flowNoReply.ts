import type { Flow, FlowNode, FlowSession, NoReply } from "./flow";

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
  const rule = session.nodeId ? noReplyOf(flow.nodes[session.nodeId]) : null;
  const lastInbound = Number(vars[LAST_INBOUND] || 0);
  if (!rule || !session.nodeId || !lastInbound) return vars;
  const at = now + rule.minutes * 60_000;
  if (at > lastInbound + WINDOW_MS) return vars; // would land outside WhatsApp's window: don't promise it
  vars[NO_REPLY_AT] = String(at);
  vars[NO_REPLY_NODE] = session.nodeId;
  return vars;
}

/** Is this stored session due a no-reply move now? */
export function noReplyDue(nodeId: string | null, vars: Record<string, string>, now: number): boolean {
  const at = Number(vars[NO_REPLY_AT] || 0);
  return Boolean(nodeId) && vars[NO_REPLY_NODE] === nodeId && at > 0 && at <= now && now < Number(vars[LAST_INBOUND] || 0) + 24 * 3_600_000;
}
