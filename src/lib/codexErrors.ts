/**
 * ChatGPT's own failure text ("could not answer: …") is the provider's words,
 * not ours — it can echo part of what was asked. Never shown to a person or
 * written to a log as is. Our fixed messages ("ChatGPT is not connected.")
 * pass through unchanged. For LOGS: a person is told aiFailureForPeople() instead.
 */
export function safeCodexError(error: string): string {
  return error.startsWith("ChatGPT could not answer") ? "ChatGPT could not answer just now — try again in a minute." : error;
}

/*
 * What a PERSON is told when the AI service fails or isn't set up — never the provider's name or its words
 * (Sean, 2026-10-18: "do not use ChatGPT wording, it could change the model in the future"). All in one place, so
 * a different model changes nothing a person reads.
 */
export const AI_NOT_CONNECTED = "DAX isn't connected to an AI service yet — set it up in Settings → Integrations.";
export const AI_BUSY = "I couldn't answer just now — the AI service is busy or over its usage limit. Try again in a few minutes.";
export const AI_FAILED = "I couldn't answer just now — the AI service didn't respond. Try again in a few minutes.";

/** The provider's failure, as a person should read it: busy/over the limit when it said so, else "didn't respond". */
export function aiFailureForPeople(reply: { error: string; transient?: true }): string {
  return reply.transient ? AI_BUSY : AI_FAILED;
}
