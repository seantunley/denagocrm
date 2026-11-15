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
 * the whole text is always a possible Xero reference, matched whole; "INV-000123" or "123" may ALSO be this CRM's
 * own number, exactly (a Xero number can be shaped INV-000123 too — re-review of #1109, so both are asked).
 * What can be neither names no invoice (null).
 */
export function parseInvoiceNumber(asked: string): { xero: string; crm?: number } | null {
  const text = asked.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,29}$/.test(text)) return null;
  const crm = /^(?:INV-?\s*)?(\d{1,9})$/i.exec(text);
  return crm ? { xero: text, crm: Number(crm[1]) } : { xero: text };
}
