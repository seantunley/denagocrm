/**
 * "How many white Rover XLs are on quotes?" — find_quotes' product/colour filter and its exact count.
 *
 * The answer used to be read off the first page of quotes, so DAX could only say "at least 9" (Sean, 2026-11-02).
 * The count is taken over EVERY matching quote the person may open, not the page shown.
 *
 * Review of #954 — vehicles, not words: a VEHICLE is a quote line linked to a catalogue product. Free-text lines are
 * not counted: on real quotes they are mostly accessories named after the cart ("Rain Cover Rover XL", "Rover XL Golf
 * Caddy"). The model is the catalogue's own product, so "Rover XL" is "Denago EV Rover XL" and never "… Rover XL 6".
 * Trade-ins, accessories, warranties and service plans, and extras the customer hasn't chosen, are never counted.
 */

type Line = { description: string; qty: number; colorPreference: string | null; kind: string; optional: boolean; selected: boolean; productId: string | null };
type Product = { id: string; name: string };

const words = (text: string | null) => ` ${(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/**
 * The catalogue models the person's words name, as whole words. One whose name ENDS with them is the model meant
 * ("Rover XL" → "Denago EV Rover XL", not "Denago EV Rover XL 6"); otherwise every model containing them ("Scout" →
 * Scout 2 and Scout 4, counted separately). None → nothing in the catalogue is called that.
 */
export function modelsNamed(products: Product[], asked: string): Product[] {
  const w = words(asked);
  if (w.trim() === "") return [];
  const named = products.filter((p) => words(p.name).includes(w));
  const precise = named.filter((p) => words(p.name).endsWith(w));
  return precise.length ? precise : named;
}

const hasColour = (line: Line, colour: string) => words(line.colorPreference).includes(words(colour)) || words(line.description).includes(words(colour));

/** `productIds`: the models asked about, or null for any vehicle (a colour on its own). */
export function lineMatches(line: Line, productIds: readonly string[] | null, colour?: string): boolean {
  if (line.kind !== "product" || (line.optional && !line.selected) || !line.productId) return false;
  if (productIds && !productIds.includes(line.productId)) return false;
  return !colour || hasColour(line, colour);
}

/** The Prisma filter for a quote with at least one such line (lineMatches' rule, for the query). */
export function quoteLineWhere(productIds: readonly string[] | null, colour?: string) {
  const insensitive = (text: string) => ({ contains: text, mode: "insensitive" as const });
  return {
    kind: "product",
    NOT: { optional: true, selected: false },
    productId: productIds ? { in: [...productIds] } : { not: null },
    ...(colour ? { OR: [{ colorPreference: insensitive(colour) }, { description: insensitive(colour) }] } : {}),
  };
}

export function countQuoted(quotes: { status: string; items: Line[] }[], products: readonly Product[] | null, colour?: string) {
  const ids = products?.map((p) => p.id) ?? null;
  const byStatus: Record<string, { quotes: number; units: number }> = {};
  const byModel: Record<string, number> = {};
  let units = 0;
  for (const quote of quotes) {
    let n = 0;
    for (const line of quote.items) {
      if (!lineMatches(line, ids, colour)) continue;
      n += line.qty;
      const model = products?.find((p) => p.id === line.productId)?.name ?? "other vehicles";
      byModel[model] = (byModel[model] ?? 0) + line.qty;
    }
    if (!n) continue;
    units += n;
    const s = (byStatus[quote.status] ??= { quotes: 0, units: 0 });
    s.quotes++;
    s.units += n;
  }
  return { quotes: Object.values(byStatus).reduce((sum, s) => sum + s.quotes, 0), units, byStatus, byModel };
}
