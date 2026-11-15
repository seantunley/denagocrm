/**
 * APPLY A CORRECTION WHILE THE ASSISTANT WORKS (DAX_Conversational_Upgrades.md, item 2).
 *
 * Something typed while an answer is still coming is queued. When it reads as a correction of the question being
 * answered — "Actually, Scout 4" — the chat OFFERS "Apply correction": stop that answer and ask the question again
 * with the correction. Nothing is replaced unless the person taps it, so this only has to be a cheap, conservative
 * guess: unsure means plain queue, as before. Pure — no model call, no database (tests/assistantCorrection.test.ts).
 *
 * ponytail: word heuristic, not language understanding; widen LEAD/SHORT if real corrections are missed.
 */

/** Opening words that say "what I asked was wrong". */
const LEAD = /^(?:actually|no|nope|sorry|oops|wait|correction|i meant|i mean|make (?:that|it)|scratch that|not\b|rather|instead)\b/i;
/** Filler that can go from the front of the correction when it is written into the question. */
const FILLER = /^(?:(?:actually|no|nope|sorry|oops|wait|correction)\b[\s,:;.!-]*)+/i;
/** A new instruction, not a fix: it waits its turn as it does today. */
const INDEPENDENT = /^(?:then|also|and|after that|next|plus|another|one more)\b/i;
/** Thanks and the like are never corrections, whatever they start with ("Actually, thanks"). */
const ACK = /^(?:thanks|thank you|thx|shot|cheers|ok|okay|great|cool|nice|perfect|lekker)\b/i;
const MAX_LENGTH = 120;
/** assistantAsk keeps this much of a question. */
const QUESTION_LIMIT = 500;
const STOP_WORDS = new Set(["the", "and", "for", "with", "what", "which", "who", "how", "that", "this", "from", "about", "please", "can", "you", "are", "was", "has", "have"]);

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether to offer "Apply correction" for `message`, queued while `active` is being answered. */
export function looksLikeCorrection(message: string, active: string): boolean {
  const text = message.trim();
  if (!text || !active.trim() || text.length > MAX_LENGTH || INDEPENDENT.test(text)) return false;
  const rest = text.replace(FILLER, "").trim();
  if (!rest || ACK.test(rest)) return false;
  if (LEAD.test(text) || /\binstead\b/i.test(text)) return true;
  const said = words(text);
  // "Scout 4, not Scout 2" — short, so "why is it not working" doesn't count.
  if (said.length <= 8 && /\S.*\bnot\b.+/i.test(text) && !/\?$/.test(text)) return true;
  // No opening word: a few words that pick up something from the question ("Scout 4" while comparing a Scout 2).
  const asked = new Set(words(active).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)));
  return said.length <= 4 && said.some((w) => asked.has(w));
}

/** The question asked again: what was being answered, with the correction under it — shown as it is sent. */
export function correctedQuestion(active: string, message: string): string {
  const fix = message.trim().replace(FILLER, "").trim() || message.trim();
  const tail = `\n\nCorrection: ${fix}`;
  // The server keeps the first QUESTION_LIMIT characters (assistantAsk): shorten the original, never the correction.
  return `${active.trim().slice(0, Math.max(0, QUESTION_LIMIT - tail.length))}${tail}`;
}
