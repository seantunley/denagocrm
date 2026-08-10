import crypto from "crypto";
import { receiptLabel } from "./deliveryReceipts";

/**
 * What to show under an outbound bubble, given BOTH halves of the truth.
 *
 * The inbox had one half. A Communication row exists from the moment a reply is
 * accepted — before the provider has been called at all — and `receiptLabel`
 * answers only "what did the customer do with it", falling back to "Sent" when
 * there is no receipt yet. So a message still sitting in the queue, a message the
 * provider rejected on every attempt, and a message that was delivered all
 * rendered the same three words: Sent ✓. The one state staff most need to see —
 * this did not reach them — was the one the interface could not express.
 *
 * The outbox row is the other half, and it is authoritative about delivery in a
 * way the timeline never was: it knows whether the send was attempted, how many
 * times, and why it stopped. A receipt still wins once the message is out, since
 * "Seen" says strictly more than "Sent".
 *
 * Pure, so every state is testable without a provider or a database.
 */

export type DeliveryTone = "muted" | "pending" | "failed";
export type DeliveryLabel = { text: string; tone: DeliveryTone };

export type DeliveryState = {
  status: string;
  failureCode?: string | null;
  attempts?: number;
};

/**
 * Plain English for a failure class, for the person holding the conversation
 * rather than for a log. Each one implies a different next action, which is the
 * whole reason the classification is worth storing.
 */
const FAILURE_REASON: Record<string, string> = {
  outside_window: "outside the 24-hour reply window",
  invalid_recipient: "this number or account is not reachable",
  rejected_by_recipient: "the customer's account rejected it",
  not_configured: "the channel is not connected",
  rate_limited: "the channel is rate-limiting us",
  transient_network: "the channel could not be reached",
  invalid_payload: "the message could not be sent in this format",
  superseded_by_human: "a person answered first",
};

export function deliveryFailureReason(failureCode: string | null | undefined): string | null {
  if (!failureCode) return null;
  return FAILURE_REASON[failureCode] ?? null;
}

/**
 * What kind of failure this was, from the only thing the providers agree on: the
 * message they sent back.
 *
 * `failureCode` existed on the ledger and nothing ever wrote it, which is worse
 * than absent — a schema that promises a retry policy can tell "the number is
 * invalid" from "Meta was briefly down", and a runtime that treats both the same.
 * Classifying the failure is what makes the promise true, and the classification
 * is acted on: a permanent one stops retrying immediately instead of spending
 * eight attempts and two hours re-asking a question with a settled answer.
 *
 * Unrecognised text is `provider_error`, which retries. Guessing "permanent" from
 * an unfamiliar message would discard a deliverable customer reply, so the
 * default has to be the recoverable one.
 *
 * Lives here rather than beside the worker so it is testable without a database,
 * and beside the words it is eventually rendered as.
 */
export function classifyDeliveryFailure(error: string): string {
  const text = error.toLowerCase();
  if (/invalid outbox payload|unsupported bot channel/.test(text)) return "invalid_payload";
  if (/24|outside the 24|window/.test(text)) return "outside_window";
  if (/not configured|no token|token is not|missing credential/.test(text)) return "not_configured";
  if (/invalid|not a valid|no such user|recipient.*(unavailable|not found)|unknown user/.test(text)) return "invalid_recipient";
  if (/blocked|unsubscribed|opt(ed)? out|policy violation|not authorized|permission/.test(text)) return "rejected_by_recipient";
  if (/rate limit|too many requests|429/.test(text)) return "rate_limited";
  if (/timeout|timed out|aborted|econn|network|socket/.test(text)) return "transient_network";
  return "provider_error";
}

/**
 * Failures that will fail identically on every retry.
 *
 * A malformed payload and an unreachable account are defects in what was queued,
 * not weather. `outside_window` is deliberately NOT here: Meta's 24-hour rule
 * reopens the moment the customer writes again, and the backoff can outlast a
 * short gap.
 */
export const PERMANENT_FAILURES = new Set([
  "invalid_payload",
  "invalid_recipient",
  "rejected_by_recipient",
]);

/**
 * The idempotency key for a staff reply: the COMPOSITION, plus what it says.
 *
 * A key that identifies only the reply box gets both halves wrong. Press Send,
 * get an ambiguous failure, correct a typo and press Send again: the key is
 * unchanged, so the corrected message is discarded as a duplicate and the
 * customer receives the version with the typo — silently, reported as sent. Mint
 * a fresh key per attempt instead and the opposite happens: a submission whose
 * response was lost sends the customer a second copy, which is the failure the
 * key exists to prevent.
 *
 * Binding the key to the payload as well as to the composition separates the two
 * questions. The same text resubmitted is the same message and dedupes; edited
 * text is a different message and sends. `compositionId` is what makes two
 * genuinely identical replies — "thanks!" typed twice, deliberately — still two
 * messages: it changes once a send is confirmed.
 *
 * Derived on the server so a client cannot get it wrong, and hashed so it is
 * bounded regardless of message length.
 */
export function staffReplyIdempotencyKey(input: {
  compositionId: string;
  channel: string;
  key: string;
  body: string;
  attachmentUrl?: string | null;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        input.compositionId,
        input.channel,
        input.key,
        input.body,
        input.attachmentUrl ?? null,
      ]),
    )
    .digest("hex");
}

export function deliveryLabel(
  message: { direction: string | null; deliveredAt?: Date | null; seenAt?: Date | null },
  channelReports: boolean,
  state?: DeliveryState | null,
): DeliveryLabel | null {
  // Inbound is never ours to report on: labelling the customer's own message
  // "Sent" is noise, and a delivery state cannot belong to it.
  if (message.direction !== "outbound") return null;

  const receipt = receiptLabel(message, channelReports);

  // A receipt is proof the message left, whatever the queue says — a worker can
  // be marked stale after the provider accepted the send. Trust the stronger
  // evidence.
  if (receipt === "Seen") return { text: "Seen ✓✓", tone: "muted" };
  if (receipt === "Delivered") return { text: "Delivered ✓✓", tone: "muted" };

  if (state) {
    if (state.status === "pending" || state.status === "running") {
      return { text: "Sending…", tone: "pending" };
    }
    if (state.status === "retry") {
      // The attempt count is the honest part: "still sending" reads as a hiccup,
      // and by the fifth attempt it is not one.
      const attempts = state.attempts && state.attempts > 1 ? ` (attempt ${state.attempts})` : "";
      return { text: `Retrying…${attempts}`, tone: "pending" };
    }
    if (state.status === "cancelled") {
      const reason = deliveryFailureReason(state.failureCode);
      return { text: reason ? `Not sent — ${reason}` : "Not sent", tone: "failed" };
    }
    if (state.status === "dead") {
      const reason = deliveryFailureReason(state.failureCode);
      return { text: reason ? `Not delivered — ${reason}` : "Not delivered", tone: "failed" };
    }
  }

  // `sent`, or an older message with no outbox record at all. Both mean the same
  // thing as far as this label goes: it left, and nothing has come back.
  return receipt === "Sent" ? { text: "Sent ✓", tone: "muted" } : null;
}

/**
 * What the person who just pressed Send should be told.
 *
 * The reply action used to answer "Sent ✓" unconditionally — including for a
 * message it had only written down, and including when the provider had already
 * rejected it. Reporting a send that did not happen is worse than reporting a
 * failure: it ends the person's attention on the conversation.
 */
export function sendOutcomeMessage(state: DeliveryState | null | undefined): {
  ok?: string;
  error?: string;
} {
  if (!state) return { ok: "Queued — sending…" };
  if (state.status === "sent") return { ok: "Sent ✓" };
  if (state.status === "dead") {
    const reason = deliveryFailureReason(state.failureCode);
    return { error: reason ? `Not delivered — ${reason}.` : "Not delivered — the channel rejected it." };
  }
  if (state.status === "cancelled") {
    const reason = deliveryFailureReason(state.failureCode);
    return { error: reason ? `Not sent — ${reason}.` : "Not sent." };
  }
  // pending / running / retry. It is written down, it is owned by the worker, and
  // it will keep trying — which is a different promise from "delivered" and has
  // to read like one.
  return { ok: "Queued — sending…" };
}
