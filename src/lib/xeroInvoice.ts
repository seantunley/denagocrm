/**
 * Quote → Xero invoice, and Xero's answers back — the PURE half of the Xero link
 * (lib/xero.ts does the HTTP). No server or database imports, so it is
 * unit-tested directly (tests/xeroInvoice.test.ts).
 *
 * Sean, 2026-11-10: the Xero invoice must MATCH the CRM invoice — same customer,
 * lines, prices, discounts, fees, VAT and total — numbered by Xero. Our invoice
 * and quote numbers go in Xero's Reference, which is also how a send finds an
 * invoice it already made.
 */
import { includedLines, lineNetCents, splitTax, LEGACY_VAT_RATE_PCT, type PricedLine } from "./pricing";
import { formatInvoiceNumber } from "./invoiceNumber";

export type XeroBillTo = {
  name: string;
  email: string;
  phone: string;
  addressLines: string[];
  vatNumber: string;
};

export type XeroQuoteInput = {
  /** The quote's id — unique across every workspace, so it ends the Reference. */
  id: string;
  number: number;
  invoiceNumber: number | null;
  taxInclusive: boolean;
  currency: string | null;
  invoicedAt: Date | null;
  /**
   * `xeroItemCode` / `xeroAccountCode`: the line's product is linked to a Xero item
   * (looked up at send time) — its code is sent, and its sales account when Xero
   * has one on the item. Description, price and VAT stay the CRM's either way.
   */
  items: Array<PricedLine & { description: string; xeroItemCode?: string | null; xeroAccountCode?: string | null }>;
  /** A fee may carry the Xero item chosen for its kind (Settings → Xero: delivery fees / other fees). */
  fees: Array<{ label: string; kind?: string | null; amountCents: number; taxRatePct?: number | null; xeroItemCode?: string | null; xeroAccountCode?: string | null }>;
};

export type XeroLine = {
  ItemCode?: string;
  Description: string;
  Quantity: number;
  UnitAmount: number;
  AccountCode: string;
  TaxType: string;
  TaxAmount: number;
  DiscountRate?: number;
};

export type XeroInvoicePayload = {
  Type: "ACCREC";
  Status: "DRAFT";
  Contact: { ContactID: string };
  Date: string;
  Reference: string;
  LineAmountTypes: "Inclusive" | "Exclusive";
  CurrencyCode?: string;
  LineItems: XeroLine[];
};

/** A Xero sales tax rate, as GET /TaxRates returns it. */
export type XeroTaxRate = {
  Name?: string;
  TaxType?: string;
  Status?: string;
  EffectiveRate?: number | string;
  CanApplyToRevenue?: boolean;
};

/** The sales account a line posts to when the workspace hasn't named one ("200" is Xero's default Sales). */
export const DEFAULT_XERO_SALES_ACCOUNT = "200";

/** YYYY-MM-DD in South African time — the day the invoice is dated in Xero. */
export function xeroDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(date);
}

/**
 * "INV-000123 / Q-1029 / <quote id>": our invoice number and the quote, so the
 * Xero invoice points back here. Also the DURABLE key a send searches Xero for
 * before creating anything — it outlives Xero's six-minute idempotency window.
 * The numbers are only unique within one workspace; the quote id is unique
 * everywhere, so two workspaces sharing one Xero organisation can never adopt
 * each other's invoice.
 */
export function xeroReference(quote: Pick<XeroQuoteInput, "id" | "number" | "invoiceNumber">): string {
  const numbers = quote.invoiceNumber ? `${formatInvoiceNumber(quote.invoiceNumber)} / Q-${quote.number}` : `Q-${quote.number}`;
  return `${numbers} / ${quote.id}`;
}

/** Every VAT rate the quote's charged lines and fees use, as percentages. */
export function quoteTaxRates(quote: XeroQuoteInput): number[] {
  return [
    ...new Set([
      ...includedLines(quote.items).map((item) => item.taxRatePct ?? LEGACY_VAT_RATE_PCT),
      ...quote.fees.map((fee) => fee.taxRatePct ?? LEGACY_VAT_RATE_PCT),
    ]),
  ];
}

/**
 * Xero's sales tax type for a VAT percentage. Only ACTIVE rates that may be used
 * on revenue, at exactly that rate. One match → it. Several at 0% → the one named
 * "zero rated" (a 0% sale on a vehicle invoice is zero-rated, not exempt). Still
 * ambiguous, or none → an error that names them, rather than a guess that puts
 * the VAT in the wrong box.
 *
 * ponytail: rates are matched by percentage; add a per-rate override in Settings
 * if a workspace ever has two live revenue rates at the same percentage.
 */
export function pickTaxType(rates: XeroTaxRate[], ratePct: number): { ok: true; taxType: string } | { ok: false; error: string } {
  const candidates = rates.filter(
    (r) => r.TaxType && r.Status === "ACTIVE" && r.CanApplyToRevenue !== false && Math.abs(Number(r.EffectiveRate) - ratePct) < 0.001,
  );
  if (candidates.length === 1) return { ok: true, taxType: candidates[0].TaxType! };
  if (candidates.length > 1 && ratePct === 0) {
    const zeroRated = candidates.filter((r) => /zero/i.test(r.Name ?? ""));
    if (zeroRated.length === 1) return { ok: true, taxType: zeroRated[0].TaxType! };
  }
  if (candidates.length === 0) return { ok: false, error: `Xero has no active sales tax rate at ${ratePct}%.` };
  return {
    ok: false,
    error: `Xero has several sales tax rates at ${ratePct}% (${candidates.map((r) => r.Name ?? r.TaxType).join(", ")}) — the CRM can't tell which one this invoice should use.`,
  };
}

/**
 * The invoice Xero is asked to create — always a DRAFT for the given Xero
 * contact. Nothing is approved or emailed from here.
 *
 * Lines are exactly the CRM invoice's rows (includedLines, then the fees), with
 * the same description, quantity, unit price and discount. Each carries the Xero
 * tax type for its VAT rate AND the VAT amount the CRM computed for it
 * (splitTax), so Xero's total is the CRM's to the cent.
 */
export function buildXeroInvoice(
  quote: XeroQuoteInput,
  opts: { contactId: string; salesAccount: string; taxTypes: Readonly<Record<string, string>> },
  now: Date = new Date(),
): XeroInvoicePayload {
  const account = opts.salesAccount.trim() || DEFAULT_XERO_SALES_ACCOUNT;
  const inclusive = quote.taxInclusive;
  const money = (cents: number) => Math.round(cents) / 100;
  const taxType = (rate: number) => {
    const type = opts.taxTypes[String(rate)];
    if (!type) throw new Error(`No Xero tax type for ${rate}% VAT.`);
    return type;
  };
  const lines: XeroLine[] = [
    ...includedLines(quote.items).map((item) => {
      const rate = item.taxRatePct ?? LEGACY_VAT_RATE_PCT;
      const discount = Math.min(100, Math.max(0, item.discountPct ?? 0));
      const line: XeroLine = {
        Description: item.description.slice(0, 4000) || "Item",
        Quantity: item.qty,
        UnitAmount: money(item.unitPriceCents),
        AccountCode: item.xeroAccountCode?.trim() || account,
        TaxType: taxType(rate),
        TaxAmount: money(splitTax(lineNetCents(item), rate, inclusive).tax),
      };
      if (item.xeroItemCode) line.ItemCode = item.xeroItemCode;
      if (discount > 0) line.DiscountRate = discount;
      return line;
    }),
    ...quote.fees.map((fee) => {
      const rate = fee.taxRatePct ?? LEGACY_VAT_RATE_PCT;
      const line: XeroLine = {
        // The same wording the CRM invoice prints for a fee (pricing.feeRows).
        Description: (fee.kind === "delivery" ? `Delivery — ${fee.label}` : fee.label).slice(0, 4000) || "Fee",
        Quantity: 1,
        UnitAmount: money(fee.amountCents),
        AccountCode: fee.xeroAccountCode?.trim() || account,
        TaxType: taxType(rate),
        TaxAmount: money(splitTax(fee.amountCents, rate, inclusive).tax),
      };
      if (fee.xeroItemCode) line.ItemCode = fee.xeroItemCode;
      return line;
    }),
  ];
  const payload: XeroInvoicePayload = {
    Type: "ACCREC",
    Status: "DRAFT",
    Contact: { ContactID: opts.contactId },
    // The date the CRM invoice carries (invoicedAt, else today — as it prints).
    Date: xeroDate(quote.invoicedAt ?? now),
    Reference: xeroReference(quote),
    LineAmountTypes: inclusive ? "Inclusive" : "Exclusive",
    LineItems: lines,
  };
  if (quote.currency) payload.CurrencyCode = quote.currency;
  return payload;
}

// ── Items ───────────────────────────────────────────────────────────────────

/** A Xero item, as GET /Items returns it. */
export type XeroItem = { ItemID?: string; Code?: string; Name?: string; IsSold?: boolean; SalesDetails?: { AccountCode?: string } };

/** The items a product may be linked to: ones Xero sells, sorted by code. */
export function sellableXeroItems(items: XeroItem[]): Array<{ id: string; code: string; name: string; accountCode: string | null }> {
  return items
    .filter((i) => i.ItemID && i.Code && i.IsSold !== false)
    .map((i) => ({ id: i.ItemID!, code: i.Code!, name: i.Name ?? "", accountCode: i.SalesDetails?.AccountCode?.trim() || null }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/** Settings keys holding the Xero item for fee lines, by fee kind. Value: JSON { id, code, name }. */
export const XERO_FEE_ITEM_KEYS = { delivery: "XERO_DELIVERY_ITEM", other: "XERO_FEE_ITEM" } as const;
export type XeroFeeKind = keyof typeof XERO_FEE_ITEM_KEYS;
export type XeroItemLink = { id: string; code: string; name: string };

/** A stored item link, or null for unset / unreadable. */
export function parseXeroItemLink(raw: string | null | undefined): XeroItemLink | null {
  try {
    const v = JSON.parse(raw ?? "");
    return v && typeof v.id === "string" && typeof v.code === "string" ? { id: v.id, code: v.code, name: String(v.name ?? "") } : null;
  } catch {
    return null;
  }
}

/** Which fee setting a fee line follows: a delivery fee its own, anything else "other fees". */
export const feeKindForXero = (kind: string | null | undefined): XeroFeeKind => (kind === "delivery" ? "delivery" : "other");

// ── Contacts ────────────────────────────────────────────────────────────────

/** A Xero contact, as GET /Contacts returns it. */
export type XeroContact = { ContactID?: string; Name?: string; EmailAddress?: string; ContactStatus?: string };

const same = (a: string | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Which existing Xero contact is this customer? Same email address first (it
 * identifies a person better than a name), then the same name — exact, ignoring
 * case and spaces at the ends. Archived contacts are skipped: Xero won't invoice
 * them. Two candidates → ambiguous, and the caller refuses rather than pick one.
 *
 * A same-name contact whose email DIFFERS from the customer's is a different
 * person until someone says otherwise → "conflict", and the caller refuses. It
 * can't create a second one either: Xero contact names are unique.
 */
export function matchXeroContact(
  contacts: XeroContact[],
  billTo: Pick<XeroBillTo, "name" | "email">,
):
  | { kind: "match"; contactId: string }
  | { kind: "none" }
  | { kind: "ambiguous"; names: string[] }
  | { kind: "conflict"; name: string } {
  // One contact can come back from both the email and the name search — count it once.
  const live = [...new Map(contacts.filter((c) => c.ContactID && c.ContactStatus !== "ARCHIVED").map((c) => [c.ContactID, c])).values()];
  const pick = (found: XeroContact[]) =>
    found.length === 1
      ? ({ kind: "match", contactId: found[0].ContactID! } as const)
      : found.length > 1
        ? ({ kind: "ambiguous", names: found.map((c) => c.Name ?? c.ContactID!) } as const)
        : null;
  const email = billTo.email.trim();
  if (email) {
    const byEmail = pick(live.filter((c) => same(c.EmailAddress, email)));
    if (byEmail) return byEmail;
  }
  const byName = live.filter((c) => same(c.Name, billTo.name));
  const clash = email ? byName.find((c) => c.EmailAddress?.trim() && !same(c.EmailAddress, email)) : undefined;
  if (clash) return { kind: "conflict", name: clash.Name ?? billTo.name };
  return pick(byName) ?? { kind: "none" };
}

/** A new Xero contact from the customer the CRM invoice is billed to — name, email, phone, address, VAT number. */
export function buildXeroContact(billTo: XeroBillTo): Record<string, unknown> {
  const contact: Record<string, unknown> = { Name: billTo.name.trim().slice(0, 255) || "Customer" };
  if (billTo.email.trim()) contact.EmailAddress = billTo.email.trim();
  if (billTo.phone.trim()) contact.Phones = [{ PhoneType: "DEFAULT", PhoneNumber: billTo.phone.trim() }];
  const lines = billTo.addressLines.map((l) => l.trim()).filter(Boolean).slice(0, 4);
  if (lines.length) {
    contact.Addresses = [Object.fromEntries([["AddressType", "POBOX"], ...lines.map((l, i) => [`AddressLine${i + 1}`, l.slice(0, 500)])])];
  }
  if (billTo.vatNumber.trim()) contact.TaxNumber = billTo.vatNumber.trim();
  return contact;
}

// ── Reading Xero's answers ──────────────────────────────────────────────────

/** What the CRM keeps from a Xero invoice. */
export type XeroInvoiceSummary = {
  id: string;
  number: string | null;
  status: string;
  totalCents: number | null;
  /** The Xero contact it is billed to. */
  contactId: string | null;
};

function summary(invoice: Record<string, unknown> | undefined): XeroInvoiceSummary | null {
  if (!invoice || typeof invoice.InvoiceID !== "string") return null;
  const contact = invoice.Contact as { ContactID?: unknown } | undefined;
  return {
    id: invoice.InvoiceID,
    number: typeof invoice.InvoiceNumber === "string" && invoice.InvoiceNumber ? invoice.InvoiceNumber : null,
    status: typeof invoice.Status === "string" ? invoice.Status : "UNKNOWN",
    totalCents: typeof invoice.Total === "number" ? Math.round(invoice.Total * 100) : null,
    contactId: typeof contact?.ContactID === "string" ? contact.ContactID : null,
  };
}

/** The first invoice in a Xero Invoices response, or null if there isn't one. */
export function readXeroInvoice(body: unknown): XeroInvoiceSummary | null {
  return summary((body as { Invoices?: Record<string, unknown>[] } | null)?.Invoices?.[0]);
}

/**
 * From a search by Reference: the live invoice this quote already has in Xero,
 * if any. Voided and deleted ones don't count — they were cancelled on purpose,
 * and a fresh send should make a new one.
 */
export function liveInvoiceWithReference(body: unknown, reference: string): XeroInvoiceSummary | null {
  const invoices = ((body as { Invoices?: Record<string, unknown>[] } | null)?.Invoices ?? []).filter(
    (i) => i.Type === "ACCREC" && i.Reference === reference && i.Status !== "VOIDED" && i.Status !== "DELETED",
  );
  return summary(invoices[0]);
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

/**
 * Which Xero organisation the owner just authorised. Only the connection from
 * THIS consent (its auth event) counts; with no event to match, only a single
 * connected organisation is unambiguous. Anything else → null, and the connect
 * is refused: picking "the most recent" could post invoices into another
 * company's books.
 */
export function chooseXeroOrganisation(
  connections: Array<{ tenantId?: string; tenantName?: string; tenantType?: string; authEventId?: string }>,
  authEventId: string | null,
): { tenantId: string; tenantName: string } | null {
  const orgs = connections.filter((c) => c.tenantType === "ORGANISATION" && c.tenantId);
  const fromThisConsent = authEventId ? orgs.filter((c) => c.authEventId === authEventId) : [];
  const chosen = fromThisConsent.length === 1 ? fromThisConsent[0] : fromThisConsent.length === 0 && orgs.length === 1 ? orgs[0] : null;
  return chosen ? { tenantId: chosen.tenantId!, tenantName: chosen.tenantName ?? "your Xero organisation" } : null;
}

/** Whether Xero's total and the CRM's differ by more than a cent of rounding. */
export function totalsDiffer(xeroTotalCents: number | null, crmTotalCents: number): boolean {
  return xeroTotalCents !== null && Math.abs(xeroTotalCents - crmTotalCents) > 1;
}

/** Xero's statuses as people read them. */
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

/** The customer's contact page in Xero. */
export function xeroContactUrl(contactId: string): string {
  return `https://go.xero.com/Contacts/View/${encodeURIComponent(contactId)}`;
}

/** The file name Xero's PDF is kept under: "INV-0042 Xero invoice.pdf". */
export function xeroPdfFileName(invoiceNumber: string | null, quoteNumber: number): string {
  return `${(invoiceNumber ?? `Q-${quoteNumber}`).replace(/[\\/:*?"<>|]+/g, "-")} Xero invoice.pdf`;
}
