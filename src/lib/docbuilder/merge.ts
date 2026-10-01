import "server-only";
import type { Prisma } from "@prisma/client";
import { contactName, DEFAULT_REGIONAL, formatDate, formatZAR, type Regional } from "@/lib/format";
import { feeRows, includedLines, lineNetCents, quotePricing, vatRateLabel } from "@/lib/pricing";
import { jobCardTotals, jobLineCents } from "@/lib/workshop-constants";
import { quoteBillTo, type BillToFleet } from "@/lib/quoteBillTo";
import type { TableRow } from "./blocks";
import { jobCardPrintFields, type JobCardPrintSource } from "./jobCardFields";
import { quoteDocTokens } from "./quoteDocs";
import { quoteValidDaysOf } from "@/lib/quoteExpiry";

/** A quote loaded for any printed/rendered document. */
export type QuoteForPrint = Prisma.QuoteGetPayload<{
  include: { items: true; fees: true; lead: { include: { product: true } }; contact: true; createdBy: true };
}>;

export type JobCardForDoc = Prisma.JobCardGetPayload<{
  include: { items: true; vehicle: true; contact: true; technician: true };
}>;

/**
 * Binds a builder document to a real CRM record: resolves {{merge.tokens}} in
 * every text field, injects the record's line items into LineItems blocks, and
 * prunes Conditional blocks whose expression is false against `vars`.
 *
 * `tokens` are display strings for {{merge}} substitution; `vars` is a typed,
 * nested scope (numbers/strings/arrays) for the conditional expression engine.
 */

export type MergeContext = {
  tokens: Record<string, string>;
  items: TableRow[];
  vars: Record<string, unknown>;
};

function firstWord(name: string | null | undefined): string {
  return name?.trim().split(/\s+/)[0] ?? "";
}

/**
 * The record-independent tokens every document gets, bound or not:
 * `{{user.name}}` (the staff member generating it — blank when there is no
 * signed-in staff member, e.g. a customer's signing page) and `{{date.today}}`.
 * `{{company.*}}` is the third such set, from companyTokens().
 */
export function documentGlobalTokens(
  userName: string | null | undefined,
  now: Date = new Date(),
  r: Pick<Regional, "locale" | "timeZone"> = DEFAULT_REGIONAL,
): Record<string, string> {
  return { "user.name": userName?.trim() ?? "", "date.today": formatDate(now, r) };
}

/**
 * `fleet` is REQUIRED, not optional, and resolved by the caller through
 * quoteBillTo.loadBillToFleet. An optional parameter is one a caller forgets, and
 * the failure mode of forgetting is a quote billed to a fleet account printing
 * the fleet manager's personal name and address where the business, its
 * registration number and its VAT number belong — on a document that goes to the
 * customer and, for a signed quote, becomes the record of what was agreed. Pass
 * null when the quote names no fleet; the tokens are then byte-for-byte what they
 * were before fleets could be billed.
 */
/**
 * `r` is the workspace's currency, locale and time zone (getRegionalSettings) —
 * required for the same reason `fleet` is. The VAT figures do NOT come from it:
 * they come from the rates stored on the quote's own lines.
 */
export function buildQuoteContext(quote: QuoteForPrint, fleet: BillToFleet | null, r: Regional): MergeContext {
  // Every document built here states a price to a customer — a signed sales
  // agreement among them — so the money comes from the canonical engine, not
  // from a local sum. Summing items alone dropped fees and delivery, and the
  // hard-coded ÷1.15 ignored both the quote's tax mode and per-line VAT rates.
  const pricing = quotePricing(quote.items, quote.fees, {
    taxInclusive: quote.taxInclusive,
    depositType: quote.depositType,
    depositValue: quote.depositValue,
  });
  const total = pricing.totalCents;
  const subtotal = pricing.netCents;
  const vat = pricing.taxCents;
  const fees = feeRows(quote.fees);
  // Only the lines the pricing above counts — an unselected optional add-on is
  // excluded from {{quote.total}}, so it must not appear as a charged row either.
  const lines = includedLines(quote.items);
  // ONE resolver, shared with the PDF, the print pages, the quotes list and the
  // deliveries board — see lib/quoteBillTo.ts for why nine hand-rolled copies of
  // "who is this for" were the thing that had to go before a third possibility
  // could be added to it.
  const billTo = quoteBillTo(quote, fleet);
  const tokens: Record<string, string> = {
    "customer.name": billTo.name,
    "customer.phone": billTo.phone,
    "customer.email": billTo.email,
    "customer.address": billTo.address,
    // New tokens, all empty string when they do not apply, so a template that
    // uses none of them renders exactly as it did. `customer.attention` is the
    // person on a quote addressed to a business; the other two are the account's
    // statutory numbers, which an invoice to a fleet has to carry.
    "customer.attention": billTo.attention ?? "",
    "customer.vatNumber": billTo.vatNumber,
    "customer.registrationNumber": billTo.registrationNumber,
    // The PERSON's first name, for "Dear …" — not the bill-to name, which for a
    // fleet quote is the business. A customerless lead falls back to its name.
    "customer.firstName": quote.contact?.firstName ?? firstWord(quote.lead?.name),
    "lead.name": quote.lead?.name ?? "",
    "lead.title": quote.lead?.title ?? "",
    "lead.source": quote.lead?.source ?? "",
    "lead.product": quote.lead?.product?.name ?? "",
    "lead.value": quote.lead ? formatZAR(quote.lead.valueCents, r) : "",
    "quote.number": `Q-${quote.number}`,
    "quote.date": formatDate(quote.createdAt, r),
    "quote.validUntil": quote.validUntil ? formatDate(quote.validUntil, r) : "—",
    // Days between THIS quote's issue and expiry — not the live setting.
    "quote.validDays": quote.validUntil ? String(quoteValidDaysOf(quote.createdAt, quote.validUntil, r.timeZone)) : "",
    "quote.subtotal": formatZAR(subtotal, r),
    "quote.vat": formatZAR(vat, r),
    // The rate(s) the quote was ISSUED at, from its own lines — so "VAT (15%)"
    // on an old quote keeps matching its figures after the setting changes.
    "quote.vatRate": vatRateLabel(lines, quote.fees),
    "quote.fees": formatZAR(pricing.feesTotalCents, r),
    "quote.total": formatZAR(Math.round(total), r),
    vehicle: quote.lead?.product?.name ?? lines[0]?.description ?? "—",
    preparedBy: quote.createdBy?.name ?? "—",
    // Invoice / sales agreement numbering, dates and party blocks — see quoteDocs.ts.
    ...quoteDocTokens(quote, billTo, pricing, new Date(), r),
  };
  // snake_case spellings of the three wording fields, so either form typed into
  // a terms line resolves (the picker inserts the camelCase ones).
  tokens["quote.valid_until"] = tokens["quote.validUntil"];
  tokens["quote.valid_days"] = tokens["quote.validDays"];
  tokens["quote.vat_rate"] = tokens["quote.vatRate"];
  const taxInclusive = quote.taxInclusive !== false;
  const items: TableRow[] = [
    ...lines.map((i) => ({
      cells: [
        { value: i.colorPreference ? `${i.description} — ${i.colorPreference}` : i.description },
        { value: String(i.qty) },
        { value: i.discountPct ? `${formatZAR(i.unitPriceCents, r)} (−${i.discountPct}%)` : formatZAR(i.unitPriceCents, r) },
        { value: formatZAR(lineNetCents(i), r) },
      ],
      qty: i.qty,
      unitPrice: i.unitPriceCents / 100,
      discountPct: Math.min(100, Math.max(0, i.discountPct ?? 0)),
      lineTotal: lineNetCents(i) / 100,
      taxRatePct: i.taxRatePct,
      taxInclusive,
    })),
    // Fees are charges on the quote, so they appear as rows. Folding them into
    // the total alone leaves the customer with a document whose lines don't add up.
    ...fees.map((fee, index) => ({
      cells: [
        { value: fee.description },
        { value: String(fee.qty) },
        { value: formatZAR(fee.unitPriceCents, r) },
        { value: formatZAR(fee.unitPriceCents, r) },
      ],
      qty: fee.qty,
      unitPrice: fee.unitPriceCents / 100,
      discountPct: 0,
      lineTotal: fee.unitPriceCents / 100,
      // feeRows keeps the order of quote.fees, so the index is the same fee.
      taxRatePct: quote.fees[index]?.taxRatePct,
      taxInclusive,
    })),
  ];
  // Typed scope for conditional expressions (amounts in rand, not cents).
  const quotation = {
    number: quote.number,
    total: Math.round(total) / 100,
    subtotal: subtotal / 100,
    vat: vat / 100,
    feesTotal: pricing.feesTotalCents / 100,
    lines: [
      ...lines.map((i) => ({
        description: i.description,
        qty: i.qty,
        price: i.unitPriceCents / 100,
        discountPct: Math.min(100, Math.max(0, i.discountPct ?? 0)),
        colour: i.colorPreference ?? "",
        total: lineNetCents(i) / 100,
      })),
      ...fees.map((fee) => ({
        description: fee.description,
        qty: fee.qty,
        price: fee.unitPriceCents / 100,
        discountPct: 0,
        colour: "",
        total: fee.unitPriceCents / 100,
      })),
    ],
    status: quote.status,
    // Lets a layout show the Subtotal / VAT lines only when the rows are ex-VAT,
    // as documentTotals() does for the fixed print pages.
    taxInclusive: quote.taxInclusive !== false,
  };
  const vars = {
    quotation,
    quote: quotation,
    customer: {
      name: tokens["customer.name"],
      email: tokens["customer.email"],
      phone: tokens["customer.phone"],
      hasContact: Boolean(quote.contact),
    },
    vehicle: tokens.vehicle,
  };
  return { tokens, items, vars };
}

export function buildJobCardContext(
  jc: JobCardForDoc & { serviceRecord?: JobCardPrintSource["serviceRecord"] },
  signatureSrc: string | null | undefined,
  r: Regional,
): MergeContext {
  const print = jobCardPrintFields(jc, signatureSrc, r);
  // Same helper as the job card record and its printed documents. Totalling
  // only "part" + "labour" dropped any other line from {{jobcard.total}} while
  // the items table below still printed it.
  const { partsCents: parts, labourCents: labour, otherCents: other, totalCents: total } = jobCardTotals(jc.items);
  const address = [jc.contact.address, jc.contact.suburb, jc.contact.city, jc.contact.province, jc.contact.postalCode].filter(Boolean).join(", ");
  const tokens: Record<string, string> = {
    "customer.name": contactName(jc.contact),
    "customer.firstName": jc.contact.firstName ?? "",
    "customer.phone": jc.contact.phone ?? "",
    "customer.email": jc.contact.email ?? "",
    "customer.address": address,
    "jobcard.number": `#${jc.number}`,
    "jobcard.status": jc.status.replace(/_/g, " "),
    "jobcard.opened": formatDate(jc.openedAt, r),
    "jobcard.completed": jc.completedAt ? formatDate(jc.completedAt, r) : "—",
    "jobcard.km": jc.kmIn != null ? `${jc.kmIn} km` : "—",
    "jobcard.description": jc.description,
    "jobcard.notes": jc.notes ?? "",
    "jobcard.total": formatZAR(total, r),
    "jobcard.parts": formatZAR(parts, r),
    "jobcard.labour": formatZAR(labour, r),
    "jobcard.other": formatZAR(other, r),
    vehicle: jc.vehicle.model,
    "vehicle.vin": jc.vehicle.vin ?? "—",
    "vehicle.reg": jc.vehicle.regNumber ?? "—",
    "vehicle.color": jc.vehicle.color ?? "—",
    technician: jc.technician?.name ?? "—",
    ...print.tokens,
  };
  const items: TableRow[] = jc.items.map((i) => ({
    cells: [
      { value: `${i.kind === "labour" ? "Labour — " : ""}${i.description}` },
      { value: String(i.qty) },
      { value: formatZAR(i.unitPriceCents, r) },
      { value: formatZAR(jobLineCents(i), r) },
    ],
    unitPrice: i.unitPriceCents / 100,
    lineTotal: jobLineCents(i) / 100,
  }));
  const vars = {
    jobcard: {
      number: jc.number,
      status: jc.status,
      total: total / 100,
      parts: parts / 100,
      labour: labour / 100,
      other: other / 100,
      lines: jc.items.map((i) => ({ description: i.description, kind: i.kind, qty: i.qty })),
      km: jc.kmIn ?? null,
      ...print.vars,
    },
    customer: { name: tokens["customer.name"], email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: jc.vehicle.model, vin: jc.vehicle.vin ?? "", reg: jc.vehicle.regNumber ?? "" },
  };
  return { tokens, items, vars };
}
