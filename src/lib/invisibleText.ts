/**
 * Strip characters that make text read one way to a person and another to a
 * model — before anything goes into the assistant's prompt or its memory
 * (Hermes' source hygiene). That is every Unicode FORMAT character (\p{Cf}:
 * zero-width spaces and marks, soft hyphens, bidi embeddings/overrides/
 * isolates, word joiners, BOMs and the invisible TAG block used to hide whole
 * instructions), the combining grapheme joiner, the Hangul fillers, and
 * variation selectors that aren't dressing an emoji. Compatibility forms are
 * folded first (NFKC), so fullwidth "ｉｇｎｏｒｅ" is "ignore" to the scans too.
 *
 * EXCEPT the zero-width joiner inside an emoji. 👨‍💼, 🏳️‍🌈 and every family or
 * profession emoji are several emojis glued by U+200D; stripping it split them
 * into pieces. It's kept only BETWEEN two emoji (an optional variation selector
 * or skin tone after the first); anywhere else — "ig<ZWJ>nore" — it still goes,
 * so it can't be used to slip a word past the injection scan. The private-use
 * stand-in that carries a kept joiner through the strip is removed from the
 * input FIRST, or typing it would smuggle a joiner back in.
 */
const EMOJI_JOINER = /(\p{Extended_Pictographic}[️\u{1F3FB}-\u{1F3FF}]?)‍(?=\p{Extended_Pictographic})/gu;
const KEEP = "\u{F0000}"; // private-use stand-in for a kept joiner while the rest is stripped
const INVISIBLE = /[\p{Cf}͏ᅟᅠㅤﾠ\u{E0100}-\u{E01EF}]/gu;
/** Variation selectors survive only straight after an emoji (✅️, ⚠️). */
const STRAY_SELECTOR = /(?<!\p{Extended_Pictographic})[︀-️]/gu;

export function stripInvisible(raw: string): string {
  return raw
    .replaceAll(KEEP, "")
    .normalize("NFKC")
    .replace(EMOJI_JOINER, `$1${KEEP}`)
    .replace(INVISIBLE, "")
    .replace(STRAY_SELECTOR, "")
    .replaceAll(KEEP, "‍");
}
