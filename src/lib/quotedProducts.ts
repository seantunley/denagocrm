/**
 * "How many white Rover XLs are on quotes?" — find_quotes' product/colour filter and its exact count.
 *
 * The answer used to be read off the first page of quotes, so DAX could only say "at least 9" (Sean, 2026-11-02).
 * The count is taken over EVERY matching quote the person may open, not the page shown.
 * A trade-in line and an optional extra the customer hasn't chosen are not on offer, so they are not counted.
 */

type Line = { description: string; qty: number; colorPreference: string | null; kind: string; optional: boolean; selected: boolean };

const has = (text: string | null, words: string) => (text ?? "").toLowerCase().includes(words.toLowerCase());

export function lineMatches(line: Line, product?: string, colour?: string): boolean {
  if (line.kind === "trade_in" || (line.optional && !line.selected)) return false;
  if (product && !has(line.description, product)) return false;
  if (colour && !has(line.colorPreference, colour) && !has(line.description, colour)) return false;
  return true;
}

/** The Prisma filter for a quote with at least one such line (lineMatches' rule, for the query). */
export function quoteLineWhere(product?: string, colour?: string) {
  const insensitive = (words: string) => ({ contains: words, mode: "insensitive" as const });
  return {
    kind: { not: "trade_in" },
    NOT: { optional: true, selected: false },
    ...(product ? { description: insensitive(product) } : {}),
    ...(colour ? { OR: [{ colorPreference: insensitive(colour) }, { description: insensitive(colour) }] } : {}),
  };
}

export function countQuoted(quotes: { status: string; items: Line[] }[], product?: string, colour?: string) {
  const byStatus: Record<string, { quotes: number; units: number }> = {};
  let units = 0;
  for (const quote of quotes) {
    const n = quote.items.filter((line) => lineMatches(line, product, colour)).reduce((sum, line) => sum + line.qty, 0);
    if (!n) continue;
    units += n;
    const s = (byStatus[quote.status] ??= { quotes: 0, units: 0 });
    s.quotes++;
    s.units += n;
  }
  return { quotes: Object.values(byStatus).reduce((sum, s) => sum + s.quotes, 0), units, byStatus };
}
