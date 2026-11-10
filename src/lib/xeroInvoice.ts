/**
 * Quote → Xero invoice, and Xero's answers back — the PURE half of the Xero link
 * (lib/xero.ts does the HTTP). No server or database imports, so it is
 * unit-tested directly (tests/xeroInvoice.test.ts).
 *
 * Sean, 2026-11-10: "send the quote to Xero, then retrieve the invoice number
 * from Xero and store it on the record here. Our invoice numbers will be
 * different from Xero." So Xero numbers the invoice itself; ours goes in Xero's
 * Reference, which ties the two together from the Xero side.
 */
import { includedLines, feeRows, type PricedLine } from "./pricing";
import { formatInvoiceNumber } from "./invoiceNumber";

export type XeroQuoteInput = {
  number: number;
  invoiceNumber: number | null;
  taxInclusive: boolean;
  currency: string | null;
  invoicedAt: Date | null;
  items: Array<PricedLine & { description: string; colorPreference?: string | null }>;
  fees: Array<{ label: string; kind?: string | null; amountCents: number }>;
  billTo: { name: string; email: string };
};

export type XeroLine = {
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  DiscountRate?: number;
};

export type XeroInvoicePayload = {
  Type: "ACCREC";
  Status: "DRAFT";
  Contact: { Name: string; EmailAddress?: string };
  Date: string;
  Reference: string;
  LineAmountTypes: "Inclusive" | "Exclusive";
  CurrencyCode?: string;
  LineItems: XeroLine[];
};

/** The sales account a line posts to when the workspace hasn't named one ("200" is Xero's default Sales). */
export const DEFAULT_XERO_SALES_ACCOUNT = "200";

/** YYYY-MM-DD in South African time — the day the invoice is dated in Xero. */
export function xeroDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(date);
}

/** "INV-000123 · Q-1029": our invoice number and the quote, so the Xero invoice points back here. */
export function xeroReference(quote: Pick<XeroQuoteInput, "number" | "invoiceNumber">): string {
  return quote.invoiceNumber ? `${formatInvoiceNumber(quote.invoiceNumber)} · Q-${quote.number}` : `Q-${quote.number}`;
}

/**
 * The invoice Xero is asked to create — always a DRAFT. Nothing is approved or
 * emailed from here: whoever does the books finalises it in Xero.
 *
 * Lines are exactly the ones the CRM's own invoice prints (includedLines + the
 * fees as rows), at the same prices and discounts, inclusive or exclusive of VAT
 * as the quote is. No TaxType is sent: each line takes its account's VAT rate in
 * Xero, and Xero's resulting total is stored and compared (see totalsDiffer),
 * rather than guessing Xero's tax codes.
 */
export function buildXeroInvoice(quote: XeroQuoteInput, salesAccount: string, now: Date = new Date()): XeroInvoicePayload {
  const account = salesAccount.trim() || DEFAULT_XERO_SALES_ACCOUNT;
  const money = (cents: number) => Math.round(cents) / 100;
  const lines: XeroLine[] = [
    ...includedLines(quote.items).map((item) => {
      const discount = Math.min(100, Math.max(0, item.discountPct ?? 0));
      const line: XeroLine = {
        Description: (item.colorPreference ? `${item.description} — ${item.colorPreference}` : item.description).slice(0, 4000) || "Item",
        Quantity: item.qty,
        UnitAmount: money(item.unitPriceCents),
        AccountCode: account,
      };
      if (discount > 0) line.DiscountRate = discount;
      return line;
    }),
    ...feeRows(quote.fees).map((fee) => ({
      Description: fee.description.slice(0, 4000) || "Fee",
      Quantity: fee.qty,
      UnitAmount: money(fee.unitPriceCents),
      AccountCode: account,
    })),
  ];
  const payload: XeroInvoicePayload = {
    Type: "ACCREC",
    Status: "DRAFT",
    Contact: { Name: (quote.billTo.name.trim() || "Customer").slice(0, 255) },
    Date: xeroDate(quote.invoicedAt ?? now),
    Reference: xeroReference(quote),
    LineAmountTypes: quote.taxInclusive ? "Inclusive" : "Exclusive",
    LineItems: lines,
  };
  const email = quote.billTo.email.trim();
  if (email) payload.Contact.EmailAddress = email;
  if (quote.currency) payload.CurrencyCode = quote.currency;
  return payload;
}

/** What the CRM keeps from a Xero invoice. */
export type XeroInvoiceSummary = { id: string; number: string | null; status: string; totalCents: number | null };

/** The first invoice in a Xero Invoices response, or null if there isn't one. */
export function readXeroInvoice(body: unknown): XeroInvoiceSummary | null {
  const invoice = (body as { Invoices?: unknown[] } | null)?.Invoices?.[0] as Record<string, unknown> | undefined;
  if (!invoice || typeof invoice.InvoiceID !== "string") return null;
  const total = typeof invoice.Total === "number" ? Math.round(invoice.Total * 100) : null;
  return {
    id: invoice.InvoiceID,
    number: typeof invoice.InvoiceNumber === "string" && invoice.InvoiceNumber ? invoice.InvoiceNumber : null,
    status: typeof invoice.Status === "string" ? invoice.Status : "UNKNOWN",
    totalCents: total,
  };
}

/**
 * Xero's refusal in words a person can act on. A validation error lists each
 * problem (an unknown account code, a contact Xero can't use); anything else
 * falls back to Xero's own message, then to the HTTP status.
 */
export function xeroErrorMessage(body: unknown, status: number): string {
  const b = (body ?? {}) as { Message?: unknown; Detail?: unknown; Elements?: Array<{ ValidationErrors?: Array<{ Message?: unknown }> }> };
  const validation = (b.Elements ?? [])
    .flatMap((element) => element.ValidationErrors ?? [])
    .map((error) => String(error.Message ?? "").trim())
    .filter(Boolean);
  if (validation.length) return [...new Set(validation)].join(" ");
  const message = [b.Detail, b.Message].find((m) => typeof m === "string" && m.trim());
  return typeof message === "string" ? message.trim() : `Xero answered ${status}.`;
}

/** Whether Xero's total and the CRM's differ by more than a cent of rounding. */
export function totalsDiffer(xeroTotalCents: number | null, crmTotalCents: number): boolean {
  return xeroTotalCents !== null && Math.abs(xeroTotalCents - crmTotalCents) > 1;
}

/** Xero's statuses as people read them on the board. */
export function xeroStatusLabel(status: string | null): string {
  switch (status) {
    case "DRAFT": return "Draft";
    case "SUBMITTED": return "Awaiting approval";
    case "AUTHORISED": return "Awaiting payment";
    case "PAID": return "Paid";
    case "VOIDED": return "Voided";
    case "DELETED": return "Deleted";
    case "SENDING": return "Sending…";
    default: return status ?? "";
  }
}

/** The invoice in Xero, for the person signed in to Xero in their browser. */
export function xeroInvoiceUrl(invoiceId: string): string {
  return `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`;
}
