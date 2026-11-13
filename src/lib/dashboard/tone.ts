/**
 * Whether a number is good news, a warning or bad news — for stat and gauge cards.
 *
 * ── WHY A CARD SAYS WHICH WAY IS BETTER ─────────────────────────────────────
 *
 * The stat card drew every rise green and every fall red. That is right for won
 * value and wrong for overdue activities, open complaints or days to close, where
 * a rise is the thing you want to know about. So a card carries `better`, and
 * both the threshold colour and the change arrow read it. Absent means "higher",
 * which is what every card saved before this field existed already showed.
 *
 * ── THRESHOLDS ARE IN THE UNITS THE PERSON TYPED ────────────────────────────
 *
 * `bands` is stored the way a gauge's target is: rands for a money metric, plain
 * numbers otherwise. The renderer scales it into cents at the one place it meets
 * the queried aggregate (see `scaleBands`), so the builder never multiplies and a
 * saved config reads the way it was written.
 *
 * ── WORDS AS WELL AS COLOUR ─────────────────────────────────────────────────
 *
 * A tone always comes with a word (`TONE_LABEL`). Colour alone fails anyone who
 * cannot tell the shades apart, and a screenshot pasted into a chat loses it.
 */

export type Better = "higher" | "lower";
export type Bands = { good: number; bad: number };
export type Tone = "good" | "warn" | "bad";

export const TONE_LABEL: Record<Tone, string> = {
  good: "On track",
  warn: "Watch",
  bad: "Off track",
};

/**
 * The tone of `value` against `bands`, or null when the card has no thresholds.
 *
 * Higher is better: at or above `good` is good, at or below `bad` is bad, and
 * anything between is a warning. Lower is better mirrors it. `good` is tested
 * first, so a pair entered the wrong way round still gives an answer — the
 * builder says the pair is back to front rather than this function refusing.
 */
export function toneFor(value: number, bands: Bands | undefined, better: Better = "higher"): Tone | null {
  if (!bands || !Number.isFinite(value)) return null;
  if (better === "higher") {
    if (value >= bands.good) return "good";
    if (value <= bands.bad) return "bad";
    return "warn";
  }
  if (value <= bands.good) return "good";
  if (value >= bands.bad) return "bad";
  return "warn";
}

/**
 * Whether a percentage change is good news. Null for no change at all.
 *
 * Zero used to be drawn green. "0%" in green reads as a small win, and it is not
 * one, so an unchanged number is now neutral either way round.
 */
export function deltaTone(delta: number, better: Better = "higher"): "good" | "bad" | null {
  if (delta === 0) return null;
  const rose = delta > 0;
  return rose === (better === "higher") ? "good" : "bad";
}

/** Bands typed in rands, scaled to the cents a money aggregate arrives in. */
export function scaleBands(bands: Bands | undefined, asMoney: boolean): Bands | undefined {
  if (!bands || !asMoney) return bands;
  return { good: Math.round(bands.good * 100), bad: Math.round(bands.bad * 100) };
}

/** Whether a pair of thresholds is the right way round for `better`. */
export function bandsInOrder(bands: Bands, better: Better = "higher"): boolean {
  return better === "higher" ? bands.good > bands.bad : bands.good < bands.bad;
}
