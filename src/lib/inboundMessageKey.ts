/**
 * The identity a replayed provider event must reuse when it writes the customer's
 * message to the transcript.
 *
 * The inbound ledger deliberately RELEASES its lease when webhook work throws, so
 * the provider redelivers. That is correct. But the transcript projection ran
 * before the rest of the work and created a fresh Communication with no provider
 * identity, so every redelivery added the customer's message again.
 *
 * On WhatsApp that is worse than a cosmetic duplicate: the AI's conversation
 * history is rebuilt from Communication rows, so a replayed message also distorts
 * what the model is answering.
 *
 * Mirrors the outbound convention already in botOutbox (`bot-outbox:<row id>`).
 * Kept import-free so the rule is executable rather than pattern-matched.
 */

/** Attachments arrive as several rows for ONE provider message, so they are indexed. */
export function inboundCommunicationKey(channel: string, providerId: string, attachmentIndex?: number): string | null {
  const id = String(providerId ?? "").trim();
  // No provider id means nothing stable to key on. Return null rather than a
  // colliding or empty key: an un-keyed row is a duplicate risk, but a key like
  // "whatsapp:" would collide EVERY message on that channel into one row and lose
  // the transcript altogether. The caller writes it un-keyed and accepts the
  // duplicate, which is the lesser failure.
  if (!id) return null;
  const base = `${channel}:${id}`;
  return attachmentIndex === undefined ? base : `${base}:attachment:${attachmentIndex}`;
}
