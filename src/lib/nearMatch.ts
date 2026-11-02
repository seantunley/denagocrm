/**
 * "Did you mean …?" for DAX (Sean, 2026-10-23). A voice note wrote "Werner Killian" for the CRM's "Werner Kilian",
 * the exact-text search found nothing, and DAX said there was no such customer. These find the near miss so DAX can
 * ASK — never act on a guess.
 */

/** Edit distance: inserts, deletes and substitutions. Names and colours are short, so the plain table is fine. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

/** Lower case, accents off, letters and digits only: "Kilián-Smith" → ["kilian", "smith"]. */
export const nameWords = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean);

/** One slip for a word of four or more letters, two from eight; a short word must match exactly. */
const closeWord = (asked: string, have: string) =>
  asked === have || (asked.length >= 4 && editDistance(asked, have) <= (asked.length >= 8 ? 2 : 1));

/**
 * The same name, misspelt: every word asked for is in the name, give or take a slip — "Werner Killian" is
 * "Werner Kilian"; "Werner" alone is "Werner Kilian" too. A different person is not ("Werner Botha").
 */
export function nameIsClose(asked: string, name: string): boolean {
  const want = nameWords(asked);
  const have = nameWords(name);
  return want.length > 0 && have.length > 0 && want.every((word) => have.some((h) => closeWord(word, h)));
}

/**
 * How alike two words are, 0–1: one minus the edits it takes, over the longer word. A word asked for that begins the
 * other ("jam" → "jameson") counts as nearly the same.
 */
export function wordCloseness(asked: string, have: string): number {
  if (asked === have) return 1;
  if (asked.length >= 3 && have.startsWith(asked)) return 0.9;
  return 1 - editDistance(asked, have) / Math.max(asked.length, have.length);
}

/**
 * How close a name is to what was asked, 0–1: each word asked for against the name's nearest word, averaged. So
 * "Clive Jammim" is close to "Clive Jammine" (0.86), less so to "Clive James" (0.75), and not near "Clive Botha" or
 * "Benjamin Smith". Words in the name nobody asked for (a middle name) cost nothing.
 */
export function nameCloseness(asked: string, name: string): number {
  const want = nameWords(asked);
  const have = nameWords(name);
  if (!want.length || !have.length) return 0;
  return want.reduce((sum, word) => sum + Math.max(...have.map((h) => wordCloseness(word, h))), 0) / want.length;
}

/** Close enough to offer as "Did you mean …?": about three letters in four right, word for word. */
export const NEAR_NAME = 0.7;

/**
 * "Did you mean …?" (Sean, 2026-10-29: "asked for clive jammim and it failed to find the client — can we not get dax
 * to present the closest options instead of asking for the spelling"). The candidates someone most likely meant,
 * closest first and at most `limit`, each close enough to offer (NEAR_NAME) by the closest of its names — a
 * customer's own name or their company's. Offered as a choice, never acted on.
 */
export function closestNames<T>(
  asked: string,
  candidates: readonly T[],
  namesOf: (candidate: T) => readonly (string | null | undefined)[],
  limit = 5,
): T[] {
  return candidates
    .map((candidate, order) => ({
      candidate,
      order,
      score: Math.max(0, ...namesOf(candidate).filter((name): name is string => Boolean(name)).map((name) => nameCloseness(asked, name))),
    }))
    .filter(({ score }) => score >= NEAR_NAME)
    // Closest first; among equals, the order given (the database's: closest spelling, then most recently worked).
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

/** The first three letters of each word of three or more: what a database search can match a misspelling on. */
export const nameStems = (asked: string) => [...new Set(nameWords(asked).filter((w) => w.length >= 3).map((w) => w.slice(0, 3)))];

/** British and American spellings of the same colour are the same colour. */
const sameSpelling = (word: string) => (word === "grey" ? "gray" : word === "colour" ? "color" : word);

/**
 * The catalogue's own spelling of the colour asked for, when it IS that colour — the same words, case and
 * grey/gray aside ("grey" → "Gray", "matte black" → "Matte Black"). Null when it is a different colour (even a
 * near one: "Dove gray" is a question, not an answer — closestColour).
 */
export function catalogueColour(asked: string, colours: readonly string[]): string | null {
  const want = nameWords(asked).map(sameSpelling).join(" ");
  return want ? colours.find((c) => nameWords(c).map(sameSpelling).join(" ") === want) ?? null : null;
}

/**
 * The catalogue colour someone most likely meant: one of its words in what they said ("Dove gray" → "Gray"), else a
 * close spelling ("Verdent" → "Verdant"). Null when nothing is near, or when two are equally near.
 */
export function closestColour(asked: string, colours: readonly string[]): string | null {
  const want = nameWords(asked);
  if (!want.length) return null;
  const exact = colours.find((c) => nameWords(c).join(" ") === want.join(" "));
  if (exact) return exact;
  const containing = colours.filter((c) => nameWords(c).every((w) => want.includes(w)));
  if (containing.length) return [...containing].sort((x, y) => nameWords(y).length - nameWords(x).length)[0];
  const scored = colours
    .map((c) => ({ c, d: editDistance(want.join(" "), nameWords(c).join(" ")) }))
    .filter(({ c, d }) => d <= Math.max(1, Math.floor(nameWords(c).join(" ").length / 4)))
    .sort((x, y) => x.d - y.d);
  if (!scored.length || (scored[1] && scored[1].d === scored[0].d)) return null;
  return scored[0].c;
}
