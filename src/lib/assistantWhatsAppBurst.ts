/*
 * MESSAGES SENT SECONDS APART ARE ONE QUESTION (Sean, 2026-11-15). He shared a contact, then typed "New lead",
 * then the email, inside three seconds; each was answered at once, blind to the other two, so "New lead" went to
 * the customer before and the new one never got a lead.
 *
 * Every Meta delivery is its own function, so a typed message waits in AssistantWhatsAppWaiting. It waits for
 * BURST_QUIET_MS; a newer message from the same person takes it over. The newest also waits while an answer of
 * theirs is still running, then takes every waiting message, oldest first, and they are answered as one. The rules
 * are here (pure); the database half is assistantWhatsApp.joinBurst.
 *
 * Measured on prod (75 WhatsApp messages, 12–15 Nov): gaps under 4 s were 0.5, 1.4, 2.8, 3.0, 3.3, 3.3; the next
 * was 5.2 s — a new question or a Confirm tap. 3.5 s of quiet joins the first lot and keeps the second apart, on
 * answers that take 5–30 s anyway. Buttons, a "yes", photos, files and voice notes never wait here.
 */

/** Quiet time after a person's newest typed message before it is answered. */
export const BURST_QUIET_MS = 3_500;
/** A claimed message older than this belongs to an answer that died (the webhook's maxDuration is 300 s). */
export const BURST_LEASE_MS = 5 * 60_000;
/** How long the newest message waits for an earlier answer before going ahead anyway. */
export const BURST_WAIT_MAX_MS = 150_000;
/** Waiting messages older than this are never answered: they are removed, not joined to a new question. */
export const BURST_STALE_MS = 10 * 60_000;
/** Room for the joined question: several typed messages, or a forwarded one and a question about it. */
export const BURST_CHARS = 6_000;

export type WaitingMessage = { messageId: string; text: string; sentAt: Date; createdAt: Date; claimedBy: string | null; claimedAt: Date | null };

/** Oldest first: when it was SENT (Meta's timestamp, whole seconds), then when it reached us. */
export const sentOrder = (a: WaitingMessage, b: WaitingMessage) =>
  a.sentAt.getTime() - b.sentAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.messageId.localeCompare(b.messageId);

/**
 * What the message `me` does now, from the person's waiting messages:
 * - "gone": another answer has taken it (or it was removed) — nothing to do;
 * - "handed": a newer message of theirs is waiting, and will answer this one too;
 * - "wait": an earlier answer of theirs is still running — its turn and cards must exist before this is read;
 * - "answer": take every waiting message and answer them.
 */
export function burstTurn(rows: readonly WaitingMessage[], me: string, now: number): "gone" | "handed" | "wait" | "answer" {
  const mine = rows.find((row) => row.messageId === me);
  if (!mine || mine.claimedBy) return "gone";
  if (rows.some((row) => !row.claimedBy && sentOrder(row, mine) > 0)) return "handed";
  if (rows.some((row) => row.claimedBy && row.claimedAt && now - row.claimedAt.getTime() < BURST_LEASE_MS)) return "wait";
  return "answer";
}

/** The messages as one question, in the order they were sent. Over BURST_CHARS: the oldest words go first. */
export function joinedQuestion(rows: readonly WaitingMessage[]): string {
  const text = [...rows].sort(sentOrder).map((row) => row.text.trim()).filter(Boolean).join("\n");
  return text.length > BURST_CHARS ? `…${text.slice(-BURST_CHARS)}` : text;
}

/** Meta's message timestamp (seconds, as a string) → a Date; anything unreadable is "now". */
export function sentAtFrom(timestamp: unknown, now = Date.now()): Date {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(now);
}
