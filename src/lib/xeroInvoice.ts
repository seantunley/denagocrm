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

/**
 * A send that has held the invoice this long is dead (a crashed request) and
 * another send may take over. Longer than any Vercel function can run, so a send
 * that is merely slow is never taken over while it still runs.
 */
export const XERO_STALE_SEND_MS = 15 * 60_000;

/**
 * A send that failed AFTER asking Xero to create the invoice: Xero may have it.
 * Locked like a send in progress, but a new send may start at once — it searches
 * Xero by Reference first, so it links the invoice if it exists.
 */
export const XERO_UNCONFIRMED = "UNCONFIRMED";

/** Xero statuses that mean the invoice was cancelled in Xero. */
export const XERO_CANCELLED_STATUSES = ["VOIDED", "DELETED"];
export const xeroInvoiceCancelled = (status: string | null | undefined) => XERO_CANCELLED_STATUSES.includes(status ?? "");

/** A send claimed it, or one failed after asking Xero to create: Xero may have an invoice the CRM doesn't. */
export const xeroSendUncertain = (status: string | null | undefined) => status === "SENDING" || status === XERO_UNCONFIRMED;

/**
 * May this invoice be sent, and under which Idempotency-Key?
 *
 * A voided (or deleted) Xero invoice stays linked — `xeroInvoiceId` — until its
 * REPLACEMENT is recorded; a send never clears it first. So every attempt at the
 * same replacement, however many fail, derives the same key from it, and that key
 * is never the original send's (review of #1067: a cleared link made the retry
 * reuse the original key, and Xero could answer with the voided invoice).
 */
export function xeroSendPlan(
  quote: { id: string; xeroInvoiceId: string | null; xeroStatus: string | null },
): { ok: false } | { ok: true; replacing: string | null; idempotencyKey: string } {
  if (quote.xeroInvoiceId && !xeroSendUncertain(quote.xeroStatus) && !xeroInvoiceCancelled(quote.xeroStatus)) return { ok: false };
  const replacing = quote.xeroInvoiceId;
  return { ok: true, replacing, idempotencyKey: replacing ? `crm-quote-${quote.id}-after-${replacing}` : `crm-quote-${quote.id}` };
}

/**
 * What a failed send leaves behind. Once Xero was asked to create — or the send
 * was itself retrying an unfinished one — Xero may have the invoice: UNCONFIRMED,
 * locked until a send checks. Otherwise exactly what was there before: nothing, or
 * the voided invoice still waiting for its replacement.
 */
export function xeroStatusAfterFailedSend(previous: string | null, createAttempted: boolean): string | null {
  return createAttempted || xeroSendUncertain(previous) ? XERO_UNCONFIRMED : previous;
}

/**
 * Sean, 2026-11-11: "Quotes can change, invoices are final." Once the invoice is
 * in Xero the CRM won't move it back to draft, revise, cancel or trash it — not
 * until it has been voided (or deleted) in Xero and Refresh has seen that. The
 * reason to show, or null when it may change. Every writer that can undo an
 * accepted quote asks this inside its locked transaction.
 *
 * A send that never finished stays locked however old it is: the CRM can't know
 * whether Xero made the invoice. Sending again settles it — it searches Xero for
 * the invoice first and links it if it was made.
 */
export function xeroLockReason(
  quote: { number: number; invoiceNumber: number | null; xeroInvoiceId: string | null; xeroInvoiceNumber: string | null; xeroStatus: string | null; xeroSentAt: Date | null },
  now: number = Date.now(),
): string | null {
  const ours = quote.invoiceNumber ? formatInvoiceNumber(quote.invoiceNumber) : `Q-${quote.number}`;
  if (quote.xeroStatus === "SENDING" || quote.xeroStatus === XERO_UNCONFIRMED) {
    return quote.xeroStatus === "SENDING" && quote.xeroSentAt && now - quote.xeroSentAt.getTime() < XERO_STALE_SEND_MS
      ? `${ours} is being sent to Xero right now. Try again in a minute.`
      : `${ours}: a send to Xero didn't finish, so the CRM can't tell whether Xero has it. Press Send invoice to Xero again — it checks Xero first and links the invoice if it was made.`;
  }
  if (!quote.xeroInvoiceId || xeroInvoiceCancelled(quote.xeroStatus)) return null;
  return `${ours} is in Xero as ${quote.xeroInvoiceNumber ?? "an invoice"}, and an invoice is final. Void it in Xero first, then press Refresh on the Deliveries board.`;
}

/** The sales account a line posts to when the workspace hasn't named one ("200" is Xero's default Sales). */
export const DEFAULT_XERO_SALES_ACCOUNT = "200";

/** YYYY-MM-DD in South African time — the day the invoice is dated in Xero. */
export function xeroDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(date);
}

/**
 * "INV-000123 / Q-1029": our invoice number and the quote, so the Xero invoice
 * points back here (Sean, 2026-11-11: nothing else — no long code). Also the
 * DURABLE key a send searches Xero for before creating anything — it outlives
 * Xero's six-minute idempotency window. Unique because both numbers are unique in
 * the workspace AND a Xero organisation is connected to one workspace only
 * (exchangeXeroCode refuses an organisation another workspace has).
 */
export function xeroReference(quote: Pick<XeroQuoteInput, "number" | "invoiceNumber">): string {
  return quote.invoiceNumber ? `${formatInvoiceNumber(quote.invoiceNumber)} / Q-${quote.number}` : `Q-${quote.number}`;
}

/**
 * The Reference sends used before 2026-11-11 ("INV-000123 / Q-1029 / <quote id>").
 * Never written any more — only SEARCHED for, so an invoice Xero made under the old
 * format whose reply was lost is still found and linked on retry, not made twice
 * (review of #1069).
 */
export function legacyXeroReference(quote: Pick<XeroQuoteInput, "id" | "number" | "invoiceNumber">): string {
  return `${xeroReference(quote)} / ${quote.id}`;
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

/** Xero's live sales tax rates at a VAT percentage. */
function salesRatesAt(rates: XeroTaxRate[], ratePct: number): XeroTaxRate[] {
  return rates.filter(
    (r) => r.TaxType && r.Status === "ACTIVE" && r.CanApplyToRevenue !== false && Math.abs(Number(r.EffectiveRate) - ratePct) < 0.001,
  );
}

/**
 * Xero's sales tax type for a VAT percentage. Only ACTIVE rates that may be used
 * on revenue, at exactly that rate. The workspace's own choice (Settings →
 * Integrations → Xero → Sales tax) is used while Xero still has it live at that
 * rate — and once it isn't, the send REFUSES and asks for a new choice, never
 * falling back to whatever rate is left (a chosen capital-goods rate must not
 * quietly become the standard one; review of #1068). No choice: one match → it. Several at 0% → the one named "zero rated" (a
 * 0% sale on a vehicle invoice is zero-rated, not exempt). Still ambiguous, or
 * none → an error that names them, rather than a guess that puts the VAT in the
 * wrong box. A South African organisation has six sales rates at 15% (2026-11-11).
 */
export function pickTaxType(
  rates: XeroTaxRate[],
  ratePct: number,
  chosen?: { taxType: string; name: string } | null,
): { ok: true; taxType: string } | { ok: false; error: string } {
  const candidates = salesRatesAt(rates, ratePct);
  if (chosen) {
    return candidates.some((r) => r.TaxType === chosen.taxType)
      ? { ok: true, taxType: chosen.taxType }
      : {
          ok: false,
          error: `The Xero rate chosen for ${ratePct}% VAT ("${chosen.name || chosen.taxType}") is no longer a live sales rate in Xero. Choose again in Settings → Integrations → Xero → Sales tax, then send again.`,
        };
  }
  if (candidates.length === 1) return { ok: true, taxType: candidates[0].TaxType! };
  if (candidates.length > 1 && ratePct === 0) {
    const zeroRated = candidates.filter((r) => /zero/i.test(r.Name ?? ""));
    if (zeroRated.length === 1) return { ok: true, taxType: zeroRated[0].TaxType! };
  }
  if (candidates.length === 0) return { ok: false, error: `Xero has no active sales tax rate at ${ratePct}%.` };
  return {
    ok: false,
    error: `Xero has several sales tax rates at ${ratePct}% (${candidates.map((r) => r.Name ?? r.TaxType).join(", ")}). Choose the one for ${ratePct}% VAT in Settings → Integrations → Xero → Sales tax, then send again.`,
  };
}

/** Settings key: the Xero sales tax rate chosen per VAT %. Value: JSON { "15": { taxType, name } }. */
export const XERO_TAX_CHOICES_KEY = "XERO_TAX_RATES";
export type XeroTaxChoices = Record<string, { taxType: string; name: string }>;

export function parseXeroTaxChoices(raw: string | null | undefined): XeroTaxChoices {
  try {
    const v = JSON.parse(raw ?? "");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v as Record<string, { taxType?: unknown; name?: unknown }>)
        .filter(([, c]) => c && typeof c.taxType === "string")
        .map(([pct, c]) => [pct, { taxType: String(c.taxType), name: String(c.name ?? "") }]),
    );
  } catch {
    return {};
  }
}

/**
 * The stored value after setting (or, with null, clearing) the choice for one VAT
 * %. The ONLY way the save action builds what it writes — so what it saves is
 * exactly what parseXeroTaxChoices reads back (review of #1068: a save that
 * validated the choice but wrote the old map reported success and stored nothing).
 */
export function withXeroTaxChoice(choices: XeroTaxChoices, pct: number, option: { taxType: string; name: string } | null): string {
  const next = { ...choices };
  if (option) next[String(pct)] = { taxType: option.taxType, name: option.name };
  else delete next[String(pct)];
  return JSON.stringify(next);
}

/**
 * Every VAT % where Xero has MORE THAN ONE live sales rate — the ones a person
 * must choose between — plus every % that already has a saved choice (`saved`),
 * however many rates Xero has left there, so a choice that went stale can always
 * be changed or cleared (review of #1068).
 */
export function xeroTaxRateChoices(
  rates: XeroTaxRate[],
  saved: number[] = [],
): Array<{ pct: number; options: Array<{ taxType: string; name: string }> }> {
  const pcts = [...new Set([...rates.map((r) => Number(r.EffectiveRate)), ...saved].filter((n) => Number.isFinite(n)))].sort((a, b) => b - a);
  return pcts
    .map((pct) => ({ pct, options: salesRatesAt(rates, pct).map((r) => ({ taxType: r.TaxType!, name: r.Name ?? r.TaxType! })) }))
    .filter((group) => group.options.length > 1 || saved.includes(group.pct));
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
  /** What Xero has received against it so far (0 when Xero doesn't say). */
  amountPaidCents: number;
  /** Credit notes / prepayments applied in Xero — not payments, so not brought back; said when present. */
  amountCreditedCents: number;
  /** Each payment Xero has recorded against it (a full invoice read; empty in search results). */
  payments: XeroPayment[];
};

/** One payment recorded in Xero against an invoice. */
export type XeroPayment = { id: string; date: Date; amountCents: number; reference: string | null };

/** Xero's JSON dates: "/Date(1573755038314+0000)/", or an ISO string. Null when unreadable. */
export function parseXeroDate(raw: unknown): Date | null {
  if (typeof raw !== "string") return null;
  const ms = /\/Date\((-?\d+)/.exec(raw)?.[1];
  const date = ms ? new Date(Number(ms)) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function paymentsOf(invoice: Record<string, unknown>): XeroPayment[] {
  const raw = Array.isArray(invoice.Payments) ? (invoice.Payments as Record<string, unknown>[]) : [];
  return raw.flatMap((p) => {
    const date = parseXeroDate(p.Date);
    const amount = typeof p.Amount === "number" ? Math.round(p.Amount * 100) : 0;
    if (typeof p.PaymentID !== "string" || !date || amount <= 0 || p.Status === "DELETED") return [];
    return [{ id: p.PaymentID, date, amountCents: amount, reference: typeof p.Reference === "string" && p.Reference.trim() ? p.Reference.trim().slice(0, 120) : null }];
  });
}

function summary(invoice: Record<string, unknown> | undefined): XeroInvoiceSummary | null {
  if (!invoice || typeof invoice.InvoiceID !== "string") return null;
  const contact = invoice.Contact as { ContactID?: unknown } | undefined;
  const cents = (v: unknown) => (typeof v === "number" && v > 0 ? Math.round(v * 100) : 0);
  return {
    id: invoice.InvoiceID,
    number: typeof invoice.InvoiceNumber === "string" && invoice.InvoiceNumber ? invoice.InvoiceNumber : null,
    status: typeof invoice.Status === "string" ? invoice.Status : "UNKNOWN",
    totalCents: typeof invoice.Total === "number" ? Math.round(invoice.Total * 100) : null,
    contactId: typeof contact?.ContactID === "string" ? contact.ContactID : null,
    amountPaidCents: cents(invoice.AmountPaid),
    amountCreditedCents: cents(invoice.AmountCredited),
    payments: paymentsOf(invoice),
  };
}

// ── Payments come from Xero ─────────────────────────────────────────────────

/** Settings key: where payments are recorded. "crm" puts the CRM's own forms back; anything else (default) = Xero. */
export const XERO_PAYMENTS_SOURCE_KEY = "XERO_PAYMENTS_SOURCE";
/** Settings key: the hourly automatic payments check — "off" stops it; anything else (default) runs it. */
export const XERO_AUTO_CHECK_KEY = "XERO_AUTO_CHECK";
/** Settings key: when the automatic check last ran for this workspace (ISO) — shown in Settings. */
export const XERO_AUTO_CHECKED_AT_KEY = "XERO_AUTO_CHECKED_AT";
/** QuotePayment.method of a payment brought back from Xero — shown as "Recorded in Xero", never offered in the CRM's form. */
export const XERO_PAYMENT_METHOD = "xero";

/**
 * Sean, 2026-11-11: "Invoices get made in CRM, pushed to Xero. Payments get
 * recorded in Xero and pushed back to the CRM." — so while payments come from
 * Xero, an invoice that is IN Xero takes its deposit and payments only from there;
 * the CRM's own forms refuse it (they stay for invoices not in Xero, and come back
 * for all with the Settings switch — "if Xero changes some day"). The refusal, or
 * null when the CRM may record it.
 */
export function xeroOwnsPayments(
  quote: { xeroInvoiceId: string | null; xeroStatus: string | null },
  paymentsFromXero: boolean,
): string | null {
  if (!paymentsFromXero || !quote.xeroInvoiceId || xeroInvoiceCancelled(quote.xeroStatus)) return null;
  return "Payments for this invoice come from Xero — record it in Xero, then press Refresh. (Settings → Integrations → Xero switches this back to the CRM.)";
}

/**
 * What the CRM holds for one invoice's money, as a payment sync reads it.
 * `createdFromXero`: the record was BROUGHT IN from Xero (a payment with method
 * "xero"; a deposit with Quote.xeroDepositCreated) — as against recorded by hand
 * and only matched to a Xero payment. An organisation switch removes the first
 * and keeps the second (review of #1071).
 */
export type CrmPaymentState = {
  deposit: { paidAt: Date | null; cents: number | null; xeroPaymentId: string | null; createdFromXero: boolean };
  payments: Array<{ id: string; xeroPaymentId: string | null; amountCents: number; receivedAt: Date; voidedAt: Date | null; createdFromXero: boolean }>;
};

export type XeroPaymentSyncPlan = {
  /**
   * keep · set (from a Xero payment) · link (a deposit recorded by hand IS this Xero payment) · update ·
   * clear (one CREATED from Xero, gone from Xero) · unlink (one recorded BY HAND whose matched Xero
   * payment is gone — kept, and reported).
   */
  deposit:
    | { kind: "keep" }
    | { kind: "set"; xeroPaymentId: string; cents: number; at: Date; createdFromXero: boolean }
    | { kind: "link"; xeroPaymentId: string }
    | { kind: "update"; cents: number; at: Date }
    | { kind: "clear" }
    | { kind: "unlink" };
  /** Payments recorded BY HAND whose matched Xero payment is gone — kept, link cleared, reported (review of #1071). */
  unlink: string[];
  /** A CRM payment record that BECAME the deposit (the earlier one was removed in Xero) — retired, so it isn't counted twice. */
  promote: string | null;
  create: XeroPayment[];
  /** A payment recorded by hand that IS this Xero payment (same amount) — linked, not duplicated. */
  link: Array<{ paymentId: string; xero: XeroPayment }>;
  update: Array<{ paymentId: string; xero: XeroPayment }>;
  /** A voided CRM copy whose Xero payment is (still, or again) in Xero — e.g. after reconnecting the organisation. */
  restore: Array<{ paymentId: string; xero: XeroPayment }>;
  /** CRM copies CREATED from Xero whose payment is no longer there (deleted or reversed) — voided. */
  void: string[];
  /** Money recorded by hand in the CRM that no Xero payment accounts for — said, never silently kept or dropped. */
  unmatched: { depositCents: number | null; payments: Array<{ id: string; amountCents: number }> };
};

/**
 * Do Xero's payment details add up to what Xero says has been paid? If not (a
 * partial answer), the sync changes NOTHING — a missing payment must never clear a
 * deposit or void a payment the CRM holds (review of #1071).
 */
export function xeroPaymentsComplete(invoice: Pick<XeroInvoiceSummary, "payments" | "amountPaidCents">): boolean {
  return invoice.payments.reduce((sum, p) => sum + p.amountCents, 0) === invoice.amountPaidCents;
}

/**
 * Make the CRM's money for one invoice mirror Xero's payments, so the invoice and
 * the statement match Xero. The earliest surviving Xero payment is the deposit
 * (the step the Deliveries board waits on) — when the deposit is removed in Xero,
 * the next one takes its place, even one already held as a payment (that record is
 * retired, never counted twice). Every other one is a payment, remembered by its
 * Xero PaymentID so nothing comes in twice; one voided earlier and present in Xero
 * again is restored. Money recorded by hand is LINKED where a Xero payment of the
 * same amount accounts for it, and reported where none does — never duplicated,
 * never deleted. Pure: the caller applies it under the quote's ledger lock, and
 * only when Xero's details add up (xeroPaymentsComplete).
 */
export function planXeroPaymentSync(state: CrmPaymentState, xeroPayments: XeroPayment[]): XeroPaymentSyncPlan {
  const xs = [...xeroPayments].sort((a, b) => a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id));
  const byXero = new Map(state.payments.filter((p) => p.xeroPaymentId).map((p) => [p.xeroPaymentId!, p]));
  const used = new Set<string>();
  const plan: XeroPaymentSyncPlan = {
    deposit: { kind: "keep" }, unlink: [], promote: null, create: [], link: [], update: [], restore: [], void: [],
    unmatched: { depositCents: null, payments: [] },
  };

  const d = state.deposit;
  let depositOpen = !d.paidAt;
  if (d.xeroPaymentId) {
    const x = xs.find((p) => p.id === d.xeroPaymentId);
    if (!x && d.createdFromXero) {
      plan.deposit = { kind: "clear" };
      depositOpen = true;
    } else if (!x) {
      // Recorded BY HAND, matched, now gone from Xero. Replaced there by a payment of the same amount
      // (a new PaymentID)? Re-match it — the same money, never counted twice. Otherwise the money
      // stays, unlinked and reported, never cleared (re-review of #1071).
      const replacement = xs.find((p) => !used.has(p.id) && !byXero.has(p.id) && p.amountCents === d.cents);
      if (replacement) {
        used.add(replacement.id);
        plan.deposit = { kind: "link", xeroPaymentId: replacement.id };
      } else {
        plan.deposit = { kind: "unlink" };
        plan.unmatched.depositCents = d.cents ?? 0;
      }
    } else {
      used.add(x.id);
      if (x.amountCents !== d.cents) plan.deposit = { kind: "update", cents: x.amountCents, at: x.date };
    }
  } else if (d.paidAt) {
    const x = xs.find((p) => !used.has(p.id) && !byXero.has(p.id) && p.amountCents === d.cents);
    if (x) {
      used.add(x.id);
      plan.deposit = { kind: "link", xeroPaymentId: x.id };
    } else {
      plan.unmatched.depositCents = d.cents ?? 0;
    }
  }
  if (depositOpen) {
    // The EARLIEST surviving payment, whether or not the CRM already holds it as a payment.
    const x = xs.find((p) => !used.has(p.id));
    if (x) {
      used.add(x.id);
      const row = byXero.get(x.id);
      const held = row && !row.voidedAt ? row : null;
      if (held) plan.promote = held.id;
      plan.deposit = { kind: "set", xeroPaymentId: x.id, cents: x.amountCents, at: x.date, createdFromXero: held ? held.createdFromXero : true };
    }
  }

  const inXero = new Set(xs.map((x) => x.id));
  const goneFromXero = state.payments.filter((p) => p.xeroPaymentId && !p.voidedAt && !inXero.has(p.xeroPaymentId));
  // Money recorded BY HAND is matched against Xero's payments before anything new is created — the
  // unlinked AND the ones whose matched Xero payment was replaced by a new one (re-review of #1071).
  const manualOpen = [
    ...state.payments.filter((p) => !p.xeroPaymentId && !p.voidedAt),
    ...goneFromXero.filter((p) => !p.createdFromXero),
  ];
  for (const x of xs) {
    if (used.has(x.id)) continue;
    used.add(x.id);
    const row = byXero.get(x.id);
    if (row) {
      if (row.voidedAt) plan.restore.push({ paymentId: row.id, xero: x });
      else if (row.amountCents !== x.amountCents || row.receivedAt.getTime() !== x.date.getTime()) plan.update.push({ paymentId: row.id, xero: x });
      continue;
    }
    const twin = manualOpen.findIndex((p) => p.amountCents === x.amountCents);
    if (twin >= 0) {
      plan.link.push({ paymentId: manualOpen[twin].id, xero: x });
      manualOpen.splice(twin, 1);
    } else {
      plan.create.push(x);
    }
  }
  // Only what was CREATED from Xero is voided; money recorded BY HAND that no Xero payment now accounts
  // for is kept, unlinked and reported (those re-matched above are in plan.link).
  plan.void = goneFromXero.filter((p) => p.createdFromXero).map((p) => p.id);
  plan.unlink = manualOpen.filter((p) => p.xeroPaymentId).map((p) => p.id);
  plan.unmatched.payments = manualOpen.map((p) => ({ id: p.id, amountCents: p.amountCents }));
  return plan;
}

/** Received in the CRM once the plan is applied: the deposit plus every live payment — Xero's own figure when they match. */
export function receivedAfterSync(state: CrmPaymentState, plan: XeroPaymentSyncPlan): number {
  const depositCents =
    plan.deposit.kind === "set" || plan.deposit.kind === "update" ? plan.deposit.cents
      : plan.deposit.kind === "clear" ? 0
        : state.deposit.paidAt ? state.deposit.cents ?? 0 : 0;
  const gone = new Set([...plan.void, ...(plan.promote ? [plan.promote] : [])]);
  const updated = new Map(plan.update.map((u) => [u.paymentId, u.xero.amountCents]));
  const linked = new Map(plan.link.map((l) => [l.paymentId, l.xero.amountCents]));
  const payments = state.payments
    .filter((p) => !p.voidedAt && !gone.has(p.id))
    .reduce((sum, p) => sum + (updated.get(p.id) ?? linked.get(p.id) ?? p.amountCents), 0);
  const restored = plan.restore.reduce((sum, r) => sum + r.xero.amountCents, 0);
  return depositCents + payments + restored + plan.create.reduce((sum, x) => sum + x.amountCents, 0);
}

/**
 * Which open invoices "Refresh all" takes next: never tried first, then the ones
 * tried longest ago — so each press moves on (the caller marks every one it takes
 * as tried BEFORE trying it, success or not). Review of #1071: ordering by when an
 * invoice was SENT took the same oldest batch on every press.
 */
export function nextXeroRefreshBatch<T extends { id: string; xeroCheckedAt: Date | null }>(rows: T[], cap: number): T[] {
  return [...rows]
    .sort((a, b) => (a.xeroCheckedAt?.getTime() ?? -Infinity) - (b.xeroCheckedAt?.getTime() ?? -Infinity) || a.id.localeCompare(b.id))
    .slice(0, cap);
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
