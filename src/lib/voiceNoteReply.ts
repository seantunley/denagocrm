/**
 * A customer's WhatsApp voice note is logged as "🎤 <transcript>", or "🎤 (Afrikaans) <transcript>", or
 * "🎤 [Voice note]" when it could not be transcribed (webhooks/whatsapp). The transcript, or null.
 */
export function voiceNoteTranscript(body: string | null | undefined): string | null {
  const m = /^🎤 (?:\([^)]{1,40}\) )?([\s\S]+)$/u.exec(body ?? "");
  const text = m?.[1].trim();
  return text && text !== "[Voice note]" ? text : null;
}

type Recent = { id: string; direction: string | null; body: string }[];
type Suggestion = { summary: string; reply: string };
export const WROTE_SINCE = "The customer has written since that voice note — reload the conversation.";

/**
 * The suggestion for ONE voice note (`messageId`, the one the button was shown for), and only while it is the
 * customer's LATEST message — checked before the AI is asked, and again after it answers, because the customer may
 * write while it is writing (reviews of #953). `recent` reads the conversation newest first; `ai` writes the reply.
 */
export async function voiceNoteSuggestion(
  messageId: string,
  deps: { recent: () => Promise<Recent>; ai: (input: { transcript: string; history: { from: "customer" | "us"; text: string }[] }) => Promise<Suggestion | { error: string }> },
): Promise<({ ok: true } & Suggestion) | { ok: false; error: string }> {
  const latestInbound = (rows: Recent) => rows.find((m) => m.direction === "inbound")?.id;
  const recent = await deps.recent();
  if (latestInbound(recent) !== messageId) return { ok: false, error: WROTE_SINCE };
  const at = recent.findIndex((m) => m.id === messageId);
  const transcript = voiceNoteTranscript(recent[at].body);
  if (!transcript) return { ok: false, error: "There's no transcribed voice note from the customer here." };
  const result = await deps.ai({
    transcript,
    history: recent.slice(at + 1).reverse().map((m) => ({ from: m.direction === "outbound" ? "us" : "customer", text: m.body })),
  });
  if ("error" in result) return { ok: false, error: result.error };
  if (latestInbound(await deps.recent()) !== messageId) return { ok: false, error: WROTE_SINCE };
  return { ok: true, ...result };
}
