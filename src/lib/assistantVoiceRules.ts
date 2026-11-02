import { voiceLanguage, type VoiceLanguage } from "./voiceLanguage";
import { speakableText } from "./spokenText";

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

/**
 * What is read aloud: the answer made fit to SAY (spokenText.speakableText — no markers, links, emoji or markdown;
 * a short list as one sentence; amounts, quote numbers and dates in words; the workspace's pronunciations), cut
 * at a sentence end at about SPOKEN_CHARS — and then saying so, so nobody thinks the voice note was the whole
 * answer. `script`: the spoken version DAX wrote for this answer, when it wrote one — preferred to the answer.
 */
export function spokenAnswer(answer: string, opts: { script?: string | null; afrikaans?: boolean; pronunciations?: readonly [string, string][]; rest?: string } = {}): string {
  const text = speakableText(opts.script?.trim() || String(answer ?? ""), { afrikaans: opts.afrikaans, pronunciations: opts.pronunciations });
  if (text.length <= SPOKEN_CHARS) return text;
  // Where the rest is: in the chat (the Listen button, under the written answer) unless the caller says otherwise.
  const rest = opts.rest ?? REST_IN_CHAT;

  // Room for the cut text, a "…" and the rest-line inside SPOKEN_CHARS.
  const room = SPOKEN_CHARS - rest.length - 2;
  const head = text.slice(0, room + 1);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s)/g)) end = m.index;
  // A sentence end past the first third: stop there. One enormous sentence:
  // stop at a word instead — still shorter than the text.
  const space = head.lastIndexOf(" ", room);
  const cut = end > room / 3 ? head.slice(0, end + 1) : `${head.slice(0, space > 0 ? space : room).trimEnd()}…`;
  return `${cut} ${rest}`;
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
 * The language this answer is read in, or null for none (text only).
 *  - A voice note in a language no model speaks (isiZulu, isiXhosa…) is
 *    answered in that language, and a voice would mangle it: text only.
 *  - An answer IN Afrikaans is read in Afrikaans; a hint that the question was
 *    spoken in Afrikaans makes one Afrikaans word enough.
 *  - Everything else: English.
 * It follows what the ANSWER is in, not what was asked: an Afrikaans question
 * answered in English is read in English.
 */
export function voiceLanguageFor(answer: string, heard?: VoiceLanguage | null): { language: "en" | "af" } | null {
  if (heard && !heard.speakable) return null;
  const { afrikaans, english } = afrikaansWords(answer);
  const enough = heard?.code === "afr" ? 1 : 2;
  if (afrikaans >= enough && afrikaans > english) return { language: voiceLanguage("afr")?.ttsLanguage ?? "af" };
  return { language: "en" };
}
