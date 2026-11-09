/**
 * Reading a supplier's invoice (review section E, 2026-11-09): the AI's answer is checked here, field by field, and
 * anything that isn't plainly an invoice number, a real date, a sensible amount or a currency code is left blank for
 * the person confirming — never guessed into shape. Pure.
 */

export const SUPPLIER_INVOICE_TYPE = "Supplier invoice";
export const isSupplierInvoice = (tag: string | null | undefined): boolean => (tag ?? "").toLowerCase() === SUPPLIER_INVOICE_TYPE.toLowerCase();

export type InvoiceFields = {
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  dueDate: Date | null;
  totalCents: number | null;
  currency: string | null;
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day as midnight UTC, or null for anything that isn't a real one ("2026-02-30" is not). */
export function invoiceDay(value: unknown): Date | null {
  const match = ISO_DAY.exec(String(value ?? "").trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === match[0] ? date : null;
}

/** "12 500.00", "R12,500.50", 12500.5 → cents; null when it isn't one positive amount below R100 million. */
export function invoiceCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value < 100_000_000 ? Math.round(value * 100) : null;
  const text = String(value ?? "").replace(/[^\d.,]/g, "");
  if (!text) return null;
  // The last "." or "," followed by exactly two digits is the decimal point; every other separator is grouping.
  const decimal = /[.,](\d{2})$/.exec(text);
  const whole = (decimal ? text.slice(0, -3) : text).replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const cents = Number(whole) * 100 + (decimal ? Number(decimal[1]) : 0);
  return cents > 0 && cents < 10_000_000_000 ? cents : null;
}

/** What the model answered, as fields to put in front of a person. Anything doubtful is null. */
export function parseInvoiceReading(reply: string): InvoiceFields {
  let raw: Record<string, unknown> = {};
  try {
    const json = reply.match(/\{[\s\S]*\}/)?.[0];
    if (json) raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    raw = {};
  }
  const number = String(raw.invoiceNumber ?? "").trim();
  const currency = String(raw.currency ?? "").trim().toUpperCase();
  return {
    invoiceNumber: number && number.length <= 60 && /[A-Za-z0-9]/.test(number) ? number : null,
    invoiceDate: invoiceDay(raw.invoiceDate),
    dueDate: invoiceDay(raw.dueDate),
    totalCents: invoiceCents(raw.total),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : null,
  };
}

export const nothingRead = (fields: InvoiceFields): boolean =>
  !fields.invoiceNumber && !fields.invoiceDate && !fields.dueDate && fields.totalCents === null;

/** The instruction to the model: extract, never invent. */
export const INVOICE_READING_PROMPT =
  "This is a supplier's invoice to a business. Read it and answer with STRICT JSON only: " +
  '{"invoiceNumber": string|null, "invoiceDate": "YYYY-MM-DD"|null, "dueDate": "YYYY-MM-DD"|null, "total": number|null, "currency": "ZAR"|"USD"|...|null}. ' +
  "total is the amount payable, VAT included. dueDate only if the invoice states one. Use null for anything not clearly on the document — never guess.";
