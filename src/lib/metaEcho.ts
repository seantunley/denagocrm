/**
 * Reconciling Meta's echo of a message the CRM sent.
 *
 * Meta echoes every message the Page sends to the webhook, including ours.
 * Recording each echo unconditionally wrote a SECOND outbound row for a message
 * already in history, so one exchange appeared twice in the thread. Dropping
 * every echo is not the fix either: an echo we did not send is a colleague
 * replying from the Facebook Page inbox, which is a real event the CRM has no
 * other way of learning about.
 *
 * WHY THIS IS NOT A GUESS ANY MORE.
 *
 * The exact answer is Meta's own message id, which the delivery worker stores
 * against the row it delivered. But we only learn that id from the response to
 * our own send, and Meta dispatches the echo the moment it accepts — so the echo
 * can arrive and be handled BEFORE the worker has committed the id. The gap is
 * one database round trip wide.
 *
 * The first attempt to close it compared the echo's TEXT against in-flight rows
 * and dropped a match. That is lossy, and not rarely: a colleague sending
 * "Thanks" from Business Suite while the CRM is sending "Thanks" loses their
 * message permanently. Canned replies — "Thanks", "Perfect", "Yes" — are exactly
 * the ones staff send by hand and exactly the ones that collide. Missing history
 * is worse than a duplicate that goes away, because nobody can see that it is
 * missing.
 *
 * So nothing is decided from content. EVERY echo the ledger cannot already claim
 * is RECORDED, carrying its provider id, and the duplicate is reconciled away
 * afterwards by whichever side commits second:
 *
 *   - the echo handler re-checks the ledger after writing, and
 *   - the worker deletes the echo row after committing the id.
 *
 * Two symmetric cleanups, so no interleaving leaves a duplicate behind:
 *
 *   worker                          webhook
 *   ──────                          ───────
 *   POST /me/messages
 *   Meta accepts, returns mid.1
 *                                   echo(mid.1): ledger has no id yet
 *                                   → RECORD it, keyed by mid.1
 *   UPDATE ... providerMessageId
 *   DELETE the echo keyed by mid.1
 *
 * and the other order:
 *
 *   UPDATE ... providerMessageId
 *   DELETE (nothing there yet)
 *                                   echo(mid.1): ledger HAS the id
 *                                   → drop, nothing written
 *
 * and the interleaving in between, where the echo handler read before the update
 * and wrote after the delete — which its own re-check catches.
 *
 * A colleague's echo carries an id no outbox row will ever hold, so nothing ever
 * deletes it. That is the property the text comparison could not give.
 */

/**
 * The dedupe key an echo-written timeline row carries.
 *
 * Doing double duty on purpose. It makes the echo insert idempotent — Meta
 * redelivers webhooks, and `Communication.dedupeKey` is unique — and it gives
 * the worker one exact row to delete, with no need to reason about which of two
 * similar rows is ours.
 *
 * Tenant-scoped because the uniqueness constraint is global: two tenants must
 * never be able to collide, whatever the provider does with its ids.
 */
export function metaEchoDedupeKey(tenantId: string, providerMessageId: string): string {
  return `meta-echo:${tenantId}:${providerMessageId}`;
}

export type EchoAction =
  | { action: "drop"; reason: "already-in-ledger" }
  | { action: "record"; dedupeKey: string; reason: "correlatable" }
  | { action: "record"; dedupeKey: null; reason: "uncorrelatable" };

/**
 * What to do with this echo.
 *
 * `ledgerHasId` means an outbox row already holds this provider id: the message
 * is demonstrably ours and is already in history, so the echo is dropped and
 * nothing is written.
 *
 * Everything else is RECORDED. Either it is somebody else's message, or it is
 * ours arriving ahead of the id — and the two are indistinguishable at this
 * instant, so the choice is between a duplicate that gets cleaned up and a
 * message that is gone. It is never worth guessing.
 *
 * An echo with no provider id at all cannot be correlated in either direction,
 * so it is recorded and stays. That is the same trade taken deliberately: a
 * duplicate is visible and survivable, a silently discarded customer-facing
 * message is neither.
 */
export function decideEcho(input: {
  tenantId: string;
  providerMessageId?: string | null;
  ledgerHasId: boolean;
}): EchoAction {
  if (input.providerMessageId && input.ledgerHasId) {
    return { action: "drop", reason: "already-in-ledger" };
  }
  if (!input.providerMessageId) {
    return { action: "record", dedupeKey: null, reason: "uncorrelatable" };
  }
  return {
    action: "record",
    dedupeKey: metaEchoDedupeKey(input.tenantId, input.providerMessageId),
    reason: "correlatable",
  };
}
