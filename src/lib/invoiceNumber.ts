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

/**
 * WHICH INVOICE A NUMBER NAMES (DAX's invoices lookup, review of #1109) — never dropped, never broadened:
 * "INV-000123" or "123" is this CRM's own number, exactly; anything else is a Xero reference, to be matched whole;
 * what can be neither names no invoice (null).
 */
export function parseInvoiceNumber(asked: string): { crm: number } | { xero: string } | null {
  const text = asked.trim();
  const crm = /^(?:INV-?\s*)?(\d{1,9})$/i.exec(text);
  if (crm) return { crm: Number(crm[1]) };
  return /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,29}$/.test(text) ? { xero: text } : null;
}
