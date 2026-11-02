/**
 * A customer's WhatsApp voice note is logged as "🎤 <transcript>", or "🎤 (Afrikaans) <transcript>", or
 * "🎤 [Voice note]" when it could not be transcribed (webhooks/whatsapp). The transcript, or null.
 */
export function voiceNoteTranscript(body: string | null | undefined): string | null {
  const m = /^🎤 (?:\([^)]{1,40}\) )?([\s\S]+)$/u.exec(body ?? "");
  const text = m?.[1].trim();
  return text && text !== "[Voice note]" ? text : null;
}
