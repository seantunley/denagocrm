/** How long a new quote is valid for when the owner has not set QUOTE_VALID_DAYS. */
export const DEFAULT_QUOTE_VALID_DAYS = 7;

/**
 * The QUOTE_VALID_DAYS setting as a day count — the ONE reading of it. Every
 * path that dates a new quote or shows the default goes through here, so the
 * number on Settings → Quotes is the number every new quote gets.
 */
export function quoteValidDays(raw: string | null | undefined): number {
  const days = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(days) && days >= 1 ? days : DEFAULT_QUOTE_VALID_DAYS;
}

/** The fallback terms a new quote starts with when QUOTE_TERMS is unset. */
export const DEFAULT_QUOTE_TERMS = "Prices include VAT. Delivery arranged on acceptance. E&OE.";

/** A quote stays signable through the end of its valid-until day. */
export function quoteExpired(validUntil: Date | null): boolean {
  if (!validUntil) return false;
  const end = new Date(validUntil);
  end.setHours(23, 59, 59, 999);
  return Date.now() > end.getTime();
}
