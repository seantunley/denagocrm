/**
 * Something GIVEN FREE with a quote ("a free dust cover") — a fee DAX was told about at R0 (Donovan, 2026-11-17:
 * every R0 fee was refused, so "quote with a free dust cover" could not be confirmed at all).
 *
 * It is saved as a R0 LINE, not a R0 fee: the quote editor drops a fee of R0 on its next save (an empty fee row),
 * while a line at R0 stays on the quote and its PDF.
 */
export function splitFreeFees<F extends { label: unknown; amountCents: number }>(fees: readonly F[]) {
  return {
    fees: fees.filter((fee) => fee.amountCents !== 0),
    free: fees
      .filter((fee) => fee.amountCents === 0)
      .map((fee) => ({ description: String(fee.label).trim(), qty: 1, unitPriceCents: 0 })),
  };
}
