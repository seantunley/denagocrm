/**
 * Typed-in wording that contradicts the workspace's settings — "Quote valid for
 * 14 days" in a layout while Settings → Quotes says 7, "VAT (15%)" after the rate
 * changed. Stored templates are the owner's own text and are never rewritten, so
 * this only WARNS (editor banner, and on Publish) and points at the merge field
 * that would keep the wording true. Pure and client-safe.
 */
export type WordingSettings = { validDays: number; vatRatePct: number };

const VALID_DAYS = /valid\s+(?:for\s+)?(\d+)\s+days?/gi;
const VAT_RATE = /VAT\s*\(\s*(\d+(?:[.,]\d+)?)\s*%\s*\)|(\d+(?:[.,]\d+)?)\s*%\s*VAT/gi;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
}

// ponytail: checks each stored string on its own, so wording split across
// rich-text formatting runs ("valid for **14** days") is not caught.
export function staleWordingWarnings(doc: unknown, settings: WordingSettings): string[] {
  const warnings = new Set<string>();
  for (const text of strings(doc)) {
    for (const match of text.matchAll(VALID_DAYS)) {
      if (Number(match[1]) !== settings.validDays) {
        warnings.add(
          `“${match[0]}” doesn't match your quote validity of ${settings.validDays} days (Settings → Quotes). ` +
            "Use {{quote.validUntil}} or {{quote.validDays}} so it always shows the quote's own dates.",
        );
      }
    }
    for (const match of text.matchAll(VAT_RATE)) {
      if (Number((match[1] ?? match[2]).replace(",", ".")) !== settings.vatRatePct) {
        warnings.add(
          `“${match[0]}” doesn't match your VAT rate of ${settings.vatRatePct}% (Settings → Quotes). ` +
            "Use {{quote.vatRate}} so it always shows the rate the quote was issued at.",
        );
      }
    }
  }
  return [...warnings];
}
