import { voiceLanguage, type VoiceLanguage } from "./voiceLanguage";

/*
 * DAX speaking its answer — the pure half (no database, no ElevenLabs), so the
 * rules can be tested on their own. assistantVoice.ts does the synthesising.
 *
 * The voice is a convenience; the text is the record. So what is read aloud is
 * a SHORT, clean version of the answer — never more than the answer itself, and
 * never the parts that only make sense on screen (links, evidence chips, emoji).
 * ElevenLabs bills per character, which is the other reason it stays short.
 */

/** The owner's switch (Settings → Assistant → WhatsApp card). Off unless set: it costs ElevenLabs credits. */
export const ASSISTANT_VOICE_REPLIES_KEY = "ASSISTANT_VOICE_REPLIES";
export const voiceRepliesSwitchOn = (raw: string | null | undefined): boolean => raw === "on";

/** About 40 seconds of speech — enough for the gist; the detail is in the text. */
export const SPOKEN_CHARS = 600;
export const REST_IN_CHAT = "The rest is in the chat.";

/** Emoji and the invisible bits that glue them together (variation selectors, joiners, keycaps, flags). */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu;

/**
 * What is read aloud: the answer without evidence markers ([[1]]), URLs, emoji
 * or markdown, each line (a list item, a heading) as its own short sentence,
 * cut at a sentence end at about SPOKEN_CHARS — and then saying so, so nobody
 * thinks the voice note was the whole answer.
 */
export function spokenAnswer(answer: string): string {
  const text = String(answer ?? "")
    .replace(/\[\[\d+\]\]/g, "")
    // A markdown link reads as its words; a bare address isn't worth hearing.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(EMOJI, "")
    .replace(/[*`]|__/g, "")
    .split(/\r?\n/)
    // Bullets, numbers, headings and quotes are layout, not words.
    // ("- " and "1. " need the space, so "-5%" and "3.5%" keep their numbers.)
    .map((line) => line.replace(/^\s*(?:[-•–]\s+|[>#]+\s*|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line))
    // Each line its own sentence, so a list doesn't run together when spoken.
    .map((line, i, all) => (i < all.length - 1 && !/[.!?:;,]$/.test(line) ? `${line}.` : line))
    .join(" ")
    .replace(/\s+([.,!?;:])/g, "$1");
  if (text.length <= SPOKEN_CHARS) return text;

  // Room for the cut text, a "…" and " The rest is in the chat." inside SPOKEN_CHARS.
  const room = SPOKEN_CHARS - REST_IN_CHAT.length - 2;
  const head = text.slice(0, room + 1);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) end = m.index;
  // A sentence end past the first third: stop there. One enormous sentence:
  // stop at a word instead — still shorter than the text.
  const space = head.lastIndexOf(" ", room);
  const cut = end > room / 3 ? head.slice(0, end + 1) : `${head.slice(0, space > 0 ? space : room).trimEnd()}…`;
  return `${cut} ${REST_IN_CHAT}`;
}

/** Common Afrikaans words that are not English words — enough to tell an Afrikaans answer from an English one. */
const AFRIKAANS = new Set([
  "die", "nie", "het", "jy", "jou", "ek", "vir", "wat", "hierdie", "julle", "hulle", "asseblief", "dankie", "baie",
  "ook", "sal", "gaan", "moet", "nog", "daar", "maar", "en", "'n", "vandag", "môre", "gister", "kliënt", "kliënte",
  "twee", "drie", "geen", "ja", "nee", "volgende", "uit", "agterstallig", "opvolg", "opvolge", "kwotasie", "kwotasies",
]);
// Words Afrikaans doesn't share ("is", "in" and "van" are both, so neither list has them).
const ENGLISH = new Set(["the", "and", "you", "your", "of", "to", "for", "with", "are", "this", "that", "have", "has", "it", "on"]);

/** ponytail: a word count, not a language model — fine for telling English from Afrikaans, the only two we can voice. */
function afrikaansWords(text: string): { afrikaans: number; english: number } {
  let afrikaans = 0;
  let english = 0;
  for (const word of text.toLowerCase().split(/[^\p{L}']+/u)) {
    if (AFRIKAANS.has(word)) afrikaans++;
    if (ENGLISH.has(word)) english++;
  }
  return { afrikaans, english };
}

/**
 * Which voice reads this answer, or null for none (text only).
 *  - A voice note in a language no model speaks (isiZulu, isiXhosa…) is
 *    answered in that language, and a voice would mangle it: text only.
 *  - An answer IN Afrikaans needs the model that speaks it (eleven_v3); a hint
 *    that the question was spoken in Afrikaans makes one Afrikaans word enough.
 *  - Everything else: the workspace's default voice model.
 * It follows what the ANSWER is in, not what was asked: an Afrikaans question
 * answered in English is read by the English voice.
 */
export function voiceLanguageFor(answer: string, heard?: VoiceLanguage | null): { ttsModel?: string } | null {
  if (heard && !heard.speakable) return null;
  const { afrikaans, english } = afrikaansWords(answer);
  const enough = heard?.code === "afr" ? 1 : 2;
  if (afrikaans >= enough && afrikaans > english) return { ttsModel: voiceLanguage("afr")?.ttsModel };
  return {};
}
