import "server-only";

/**
 * The terminal states of a SignatureRequest. A request in any of these has
 * reached a final outcome and must never be resent, re-dispatched, notified,
 * advanced, completed, or treated as the record's active request. The schema
 * declares status as draft|sent|viewed|in_progress|completed|declined|expired|
 * voided|rejected — so the closed set is everything past the live states.
 * Centralised so no single lifecycle path forgets one (e.g. `rejected`, set by
 * workflow rejection, and `expired`).
 */
export const CLOSED_REQUEST_STATUSES = [
  "completed",
  "declined",
  "voided",
  "expired",
  "rejected",
] as const;

export function isRequestClosed(status: string): boolean {
  return (CLOSED_REQUEST_STATUSES as readonly string[]).includes(status);
}
