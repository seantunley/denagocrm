/**
 * ChatGPT's own failure text ("could not answer: …") is the provider's words,
 * not ours — it can echo part of what was asked. Never shown to a person or
 * written to a log as is. Our fixed messages ("ChatGPT is not connected.")
 * pass through unchanged.
 */
export function safeCodexError(error: string): string {
  return error.startsWith("ChatGPT could not answer") ? "ChatGPT could not answer just now — try again in a minute." : error;
}
