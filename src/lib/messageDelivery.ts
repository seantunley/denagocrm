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
 * Failures a retry cannot fix.
 *
 * A malformed payload and an unreachable account are defects in what was queued,
 * not weather.
 *
 * `outside_window` belongs here too, and putting it in the retryable set was
 * wrong. Meta's 24-hour rule reopens on an INBOUND CUSTOMER MESSAGE, not on the
 * passage of time — so a backoff cannot reach it, and eight attempts over two
 * hours is a message that was never going to arrive, dressed as one still in
 * flight. Worse, if the window did happen to reopen, an answer composed two
 * hours earlier would go out unannounced into a conversation that has moved on.
 * Failing immediately tells the person the one thing they can act on: the
 * customer has to write first.
 *
 * `not_configured` is deliberately NOT here. A revoked or mid-rotation
 * credential is genuinely repairable by an operator inside the retry window, and
 * the queue recovering by itself is worth more than failing fast — provided the
 * person who pressed Send is told immediately, which `sendOutcomeMessage` now
 * does.
 */
export const PERMANENT_FAILURES = new Set([
  "invalid_payload",
  "invalid_recipient",
  "rejected_by_recipient",
  "outside_window",
]);

/**
 * Everything that has to be the same for two submissions to be the same send.
 *
 * Not just the words: a reply is addressed (channel + recipient), attributed (an
 * actor) and filed against a record (a contact and/or a lead). Two submissions
 * agreeing on the text while differing on any of those are different sends, and
 * treating them as one loses the second silently.
 */
export type StaffReplyIdentity = {
  compositionId: string;
  channel: string;
  /** Provider recipient identity: WhatsApp digits, PSID, IG id. */
  key: string;
  actorId: string;
  contactId?: string | null;
  leadId?: string | null;
  body: string;
  attachmentUrl?: string | null;
};

/** The identity as a stable ordered tuple — the one place its shape is decided. */
function identityTuple(input: StaffReplyIdentity): unknown[] {
  return [
    input.compositionId,
    input.channel,
    input.key,
    input.actorId,
    input.contactId ?? null,
    input.leadId ?? null,
    input.body,
    input.attachmentUrl ?? null,
  ];
}

/**
 * The idempotency key for a staff reply: the COMPOSITION, plus everything that
 * makes it this send and not another.
 *
 * A key that identifies only the reply box gets both halves wrong. Press Send,
 * get an ambiguous failure, correct "Yes, we have stock" to "Sorry, we don't
 * have stock" and press Send again: the key is unchanged, so the correction is
 * discarded as a duplicate and the customer receives the OPPOSITE of what the
 * salesperson decided to say — reported as sent. Mint a fresh key per attempt
 * instead and the reverse happens: a submission whose response was lost sends
 * the customer a second copy, which is the failure the key exists to prevent.
 *
 * Binding the key to the payload separates those two questions. The same text
 * resubmitted is the same message and dedupes; edited text is a different
 * message and sends. `compositionId` is what keeps two deliberately identical
 * replies — "thanks!" typed twice — two messages: it changes once a send is
 * confirmed.
 *
 * The actor and the record identity are in the key for the same reason the body
 * is. Without them, a replayed `compositionId` from a colleague's box, or the
 * same words to the same number filed against a DIFFERENT lead, collides with a
 * send it is not — and the caller is told "already sent" about somebody else's
 * message.
 *
 * Derived on the server so a client cannot get it wrong, and hashed so it is
 * bounded regardless of message length.
 */
export function staffReplyIdempotencyKey(input: StaffReplyIdentity): string {
  return crypto.createHash("sha256").update(JSON.stringify(identityTuple(input))).digest("hex");
}

/**
 * Does an outbox row that already holds this key describe the SAME send?
 *
 * With every identity field folded into the key above, a mismatch here needs a
 * SHA-256 collision — so this is not the primary defence, and it is not meant to
 * be. It is the check that keeps the guarantee true if the derivation ever loses
 * a field: a key is a claim about identity, and a claim that cannot be verified
 * against the row it matched is one that will eventually be wrong quietly. This
 * makes that case loud instead.
 *
 * The payload is compared canonically. It goes to Postgres as `jsonb`, which does
 * NOT preserve key order, so comparing serialised forms directly would report a
 * mismatch for two identical messages.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function staffReplyMatchesRow(
  input: { channel: string; key: string; actorId: string; contactId?: string | null; leadId?: string | null; payload: unknown },
  row: { channel: string; key: string; actorId: string | null; contactId: string | null; leadId: string | null; payload: unknown },
): boolean {
  return (
    row.channel === input.channel &&
    row.key === input.key &&
    row.actorId === input.actorId &&
    row.contactId === (input.contactId ?? null) &&
    row.leadId === (input.leadId ?? null) &&
    canonicalJson(row.payload) === canonicalJson(input.payload)
  );
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
      // The reason and the attempt count are the honest parts: "still sending"
      // reads as a hiccup, and by the fifth attempt against a revoked credential
      // it is not one. Failed tone, because something has already gone wrong —
      // this is not the same as a message that has simply not left yet.
      const reason = deliveryFailureReason(state.failureCode);
      const attempts = state.attempts && state.attempts > 1 ? ` (attempt ${state.attempts})` : "";
      return {
        text: reason ? `Retrying — ${reason}${attempts}` : `Retrying…${attempts}`,
        tone: "failed",
      };
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
 *
 * "Queued — sending…" fixed the wording and not the defect. The reply action
 * drains the conversation before reading this, so by the time we answer, the
 * provider has usually already had its say — and a message WhatsApp has just
 * refused was still being reported in green, as though it were merely in flight.
 * The attempt count is what separates the two: zero attempts means nobody has
 * tried yet, and anything above zero on a non-terminal row means the provider
 * refused it at least once and the queue is going to keep asking.
 *
 * That distinction is the whole point. "Queued" invites the person to move on;
 * "rejected, still retrying" invites them to look at why, which for a revoked
 * credential or a closed reply window is the only thing that will help.
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
  // pending / running / retry, and the provider has already refused it at least
  // once. Still queued, but saying only that would be the original lie in a
  // quieter voice.
  if ((state.attempts ?? 0) > 0) {
    const reason = deliveryFailureReason(state.failureCode);
    return {
      error: reason
        ? `Not sent yet — ${reason}. Still retrying in the background.`
        : "Not sent yet — the channel refused it. Still retrying in the background.",
    };
  }
  // Written down, owned by the worker, not yet attempted. A different promise
  // from "delivered", and it has to read like one.
  return { ok: "Queued — sending…" };
}
