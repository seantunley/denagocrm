/**
 * Deciding whether a Meta echo is the CRM's own message coming back.
 *
 * Meta echoes every message the Page sends to the webhook, including ours.
 * Recording each echo unconditionally wrote a SECOND outbound row for a message
 * already in history, so one exchange appeared twice in the thread. Dropping
 * every echo is not the fix either: an echo we did not send is a colleague
 * replying from the Facebook Page inbox, which is a real event the CRM has no
 * other way of learning about.
 *
 * The rule is here, away from the database, because it is the part that is easy
 * to get subtly wrong and impossible to check by reading a query.
 */

/**
 * How long after a DELIVERY ATTEMPT an echo can still be recognised by content.
 *
 * WHICH CLOCK matters more than how long, and the first version measured from
 * the wrong one. It bounded `createdAt` — when the message was QUEUED — which is
 * not when it is sent. A durable queue exists precisely so those can be far
 * apart:
 *
 *   10:00  reply queued
 *   10:00  worker unavailable — deployment, outage, paused drain, backlog
 *   10:20  worker recovers, claims the row, sends it
 *   10:20  Meta accepts and emits the echo immediately
 *   10:20  the echo arrives before providerMessageId has been committed
 *
 * That row is in flight AT THIS MOMENT, and a ten-minute bound on `createdAt`
 * excluded it — so the outage the queue survived produced exactly the duplicate
 * the queue was meant to prevent, and the longer the outage the more certain it
 * became.
 *
 * The clock is the current attempt: the LEASE for a claimed row, `sentAt` for
 * one already sent. Both move with the attempt, so an hour spent waiting in the
 * queue changes nothing.
 *
 * Only the race uses this at all — an exact id match has no window. Ten minutes
 * is far longer than the gap it covers (one HTTP response) and short enough that
 * yesterday's identical greeting is not mistaken for today's.
 */
export const ECHO_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

/** A queued delivery, as much of it as this decision needs. */
export type LedgerRow = { providerMessageId: string | null; payload: unknown };

/**
 * The text a queued payload would have put on the wire, or null when the message
 * carries no text at all (a bare attachment, which arrives as an echo with no
 * text and is never matched against this).
 */
export function outboundTextOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const message = payload as { type?: string; text?: string; caption?: string };
  if (message.type === "text" || message.type === "choice") {
    return typeof message.text === "string" ? message.text : null;
  }
  if (message.type === "image") {
    return typeof message.caption === "string" && message.caption.length > 0 ? message.caption : null;
  }
  return null;
}

export type EchoDecision = {
  /** Whether to drop the echo instead of writing it into history. */
  ours: boolean;
  /** Which rule answered — so a log or a test can say WHY, not just what. */
  reason: "provider-id" | "in-flight-content" | "not-ours";
};

/**
 * Is this echo ours?
 *
 * `ledgerHasId` is the exact answer: the delivery worker stores Meta's own id
 * against the row it delivered, so an echo bearing that id is unambiguously our
 * message.
 *
 * THE RACE THAT LEAVES. We only learn the id from the response to our own send,
 * and Meta dispatches the echo the moment it accepts — so the echo webhook can
 * arrive and be processed BEFORE the worker has written the id to the row. In
 * that window the ledger holds our message but not its id, the id check misses,
 * and the duplicate this exists to prevent is written anyway. It is not an exotic
 * interleaving: the gap is exactly one database round trip wide.
 *
 * `inFlight` closes it — rows on this same conversation, recent, that have NO
 * provider id yet. A row that already carries an id has been reconciled, so an
 * echo bearing a different id genuinely is a different message and is recorded.
 * That condition is the whole reason the fallback is narrow rather than a
 * content-dedupe that would swallow legitimate repeats.
 *
 * WHAT IT COSTS, PLAINLY: if a colleague types the identical text in the Page
 * inbox during the seconds our own identical message is in flight, their echo is
 * dropped. Against duplicating history on every single send, that is the right
 * trade — but it is a real loss, not a hypothetical one.
 */
export function decideEcho(input: {
  text: string;
  providerMessageId?: string | null;
  ledgerHasId: boolean;
  inFlight: LedgerRow[];
}): EchoDecision {
  if (input.providerMessageId && input.ledgerHasId) return { ours: true, reason: "provider-id" };
  // An empty echo body cannot be matched by content: every text-less row would
  // look like it. Only the id can speak for those.
  if (input.text.length === 0) return { ours: false, reason: "not-ours" };
  const matched = input.inFlight.some(
    (row) => row.providerMessageId === null && outboundTextOf(row.payload) === input.text,
  );
  return matched
    ? { ours: true, reason: "in-flight-content" }
    : { ours: false, reason: "not-ours" };
}
