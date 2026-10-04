/**
 * Strip characters that make text read one way to a person and another to a
 * model — before anything goes into the assistant's prompt (Hermes' source
 * hygiene): zero-width spaces and marks, bidi embeddings/overrides/isolates,
 * word joiners, BOMs and tag characters.
 *
 * EXCEPT the zero-width joiner inside an emoji. 👨‍💼, 🏳️‍🌈 and every family or
 * profession emoji are several emojis glued by U+200D; stripping it split them
 * into pieces. It's kept only BETWEEN two emoji (an optional variation selector
 * or skin tone after the first); anywhere else — "ig<ZWJ>nore" — it still goes,
 * so it can't be used to slip a word past the injection scan.
 */
const EMOJI_JOINER = /(\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]?)‍(?=\p{Extended_Pictographic})/gu;
const KEEP = "\u{F0000}"; // private-use stand-in for a kept joiner while the rest is stripped
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]|[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(raw: string): string {
  return raw
    .replace(EMOJI_JOINER, `$1${KEEP}`)
    .replace(INVISIBLE, "")
    .replaceAll(KEEP, "‍");
}
