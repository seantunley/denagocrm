/**
 * A tax invoice's own number (Sean, 2026-10-07): "the invoice number must be
 * something different to the quote number — can't be the same with just the
 * prefix changed". Each workspace has its own sequence, 1, 2, 3…, printed as
 * INV-000001. It is issued once, when the quote is accepted
 * (numbering.issueInvoiceNumberInTx), and never reused.
 */

/** INV-000123, or a plain note for a quote that isn't an invoice yet. */
export function formatInvoiceNumber(n: number | null | undefined): string {
  return n ? `INV-${String(n).padStart(6, "0")}` : "Not yet issued";
}
