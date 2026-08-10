/**
 * Who owns a conversation, and what an inbound customer message is allowed to do
 * about it.
 *
 * `BotSession.status` used to carry this on its own, and `paused` meant two
 * incompatible things: "the bot handed off" and "a staff member took this over".
 * Because any of `menu|hi|hello|hey|start|restart|begin` counted as a restart, a
 * customer typing "hi" while a salesperson was mid-conversation brought the bot
 * back and restarted the flow. That breaks the shared-inbox ownership guarantee
 * outright, and narrowing the pattern would not have fixed it — the session has
 * to record WHY it is paused.
 *
 * Kept import-free so the rule can be executed by a test rather than inferred
 * from a regex over the runtime.
 */
export type BotOwnership =
  /** The bot is driving. */
  | "bot"
  /** The bot handed off (low confidence, an explicit ask, a handoff node). */
  | "ai_handoff"
  /** A person took the conversation. Only a person gives it back. */
  | "human"
  /** The last thing we said definitively failed to reach the customer. */
  | "delivery_failed";

export type InboundAct =
  /** Say nothing. The conversation belongs to someone else. */
  | { act: "suppress" }
  /** Continue from the stored node with the stored variables. */
  | { act: "resume" }
  /** Begin a fresh run, discarding the stored graph position. */
  | { act: "restart" };

/**
 * Only these escape a bot handoff. Greetings are not control commands — a
 * customer saying "hi" to the person helping them is not asking for a menu.
 */
export const RESUME_COMMAND = /^\s*(menu|restart|start\s*over|start\s*again)\b/i;

/**
 * The broader set that restarts a conversation the BOT still owns. This is
 * existing behaviour and deliberately unchanged: mid-flow, "hi" meaning "take me
 * back to the top" is harmless, because nobody else is holding the conversation.
 */
export const RESTART_COMMAND = /^\s*(menu|hi|hello|hey|start|restart|begin)\b/i;

export function decideInboundAct(input: {
  /** null when there is no live session at all. */
  ownership: BotOwnership | null;
  text: string;
  /** A tapped button is never a text command. */
  hasChoiceId: boolean;
}): InboundAct {
  const { ownership, text, hasChoiceId } = input;
  if (!ownership) return { act: "restart" };

  // A person is holding this conversation. Nothing the customer types takes it
  // back — not "menu", not "restart". Only an explicit staff release does, which
  // is a different code path entirely (resumeBotConversation).
  if (ownership === "human") return { act: "suppress" };

  // The last outbound message exhausted its retries, so the customer never saw
  // it. Resuming would interpret their next message against a prompt that does
  // not exist for them — answering a menu they were never shown. Start over
  // instead; that is the only state both sides can agree on.
  if (ownership === "delivery_failed") return { act: "restart" };

  if (ownership === "ai_handoff") {
    if (hasChoiceId) return { act: "suppress" };
    return RESUME_COMMAND.test(text) ? { act: "restart" } : { act: "suppress" };
  }

  // ownership === "bot"
  if (!hasChoiceId && RESTART_COMMAND.test(text)) return { act: "restart" };
  return { act: "resume" };
}
