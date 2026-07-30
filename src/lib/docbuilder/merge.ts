import "server-only";
import type { Prisma } from "@prisma/client";
import { contactName, formatDate, formatZAR } from "@/lib/format";
import { feeRows, lineNetCents, quotePricing } from "@/lib/pricing";
import { jobCardTotals, jobLineCents } from "@/lib/workshop-constants";
import type { QuoteForPrint } from "@/components/print/QuotePrintDoc";
import type { BuilderData, TableRow } from "./blocks";
import { evaluateCondition } from "./expr";

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

export function buildQuoteContext(quote: QuoteForPrint): MergeContext {
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
  const address = quote.contact
    ? [quote.contact.address, quote.contact.suburb, quote.contact.city, quote.contact.province, quote.contact.postalCode].filter(Boolean).join(", ")
    : "";
  const tokens: Record<string, string> = {
    "customer.name": quote.contact ? contactName(quote.contact) : quote.lead?.name ?? "",
    "customer.phone": quote.contact?.phone ?? quote.lead?.phone ?? "",
    "customer.email": quote.contact?.email ?? quote.lead?.email ?? "",
    "customer.address": address,
    "quote.number": `Q-${quote.number}`,
    "quote.date": formatDate(quote.createdAt),
    "quote.validUntil": quote.validUntil ? formatDate(quote.validUntil) : "—",
    "quote.subtotal": formatZAR(subtotal),
    "quote.vat": formatZAR(vat),
    "quote.fees": formatZAR(pricing.feesTotalCents),
    "quote.total": formatZAR(Math.round(total)),
    vehicle: quote.lead?.product?.name ?? quote.items[0]?.description ?? "—",
    preparedBy: quote.createdBy?.name ?? "—",
  };
  const items: TableRow[] = [
    ...quote.items.map((i) => ({
      cells: [
        { value: i.colorPreference ? `${i.description} — ${i.colorPreference}` : i.description },
        { value: String(i.qty) },
        { value: i.discountPct ? `${formatZAR(i.unitPriceCents)} (−${i.discountPct}%)` : formatZAR(i.unitPriceCents) },
        { value: formatZAR(lineNetCents(i)) },
      ],
      qty: i.qty,
      unitPrice: i.unitPriceCents / 100,
      discountPct: Math.min(100, Math.max(0, i.discountPct ?? 0)),
    })),
    // Fees are charges on the quote, so they appear as rows. Folding them into
    // the total alone leaves the customer with a document whose lines don't add up.
    ...fees.map((fee) => ({
      cells: [
        { value: fee.description },
        { value: String(fee.qty) },
        { value: formatZAR(fee.unitPriceCents) },
        { value: formatZAR(fee.unitPriceCents) },
      ],
      qty: fee.qty,
      unitPrice: fee.unitPriceCents / 100,
      discountPct: 0,
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
      ...quote.items.map((i) => ({
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

export function buildJobCardContext(jc: JobCardForDoc): MergeContext {
  // Same helper as the job card record and its printed documents. Totalling
  // only "part" + "labour" dropped any other line from {{jobcard.total}} while
  // the items table below still printed it.
  const { partsCents: parts, labourCents: labour, otherCents: other, totalCents: total } = jobCardTotals(jc.items);
  const address = [jc.contact.address, jc.contact.suburb, jc.contact.city, jc.contact.province, jc.contact.postalCode].filter(Boolean).join(", ");
  const tokens: Record<string, string> = {
    "customer.name": contactName(jc.contact),
    "customer.phone": jc.contact.phone ?? "",
    "customer.email": jc.contact.email ?? "",
    "customer.address": address,
    "jobcard.number": `#${jc.number}`,
    "jobcard.status": jc.status.replace(/_/g, " "),
    "jobcard.opened": formatDate(jc.openedAt),
    "jobcard.completed": jc.completedAt ? formatDate(jc.completedAt) : "—",
    "jobcard.km": jc.kmIn != null ? `${jc.kmIn} km` : "—",
    "jobcard.description": jc.description,
    "jobcard.notes": jc.notes ?? "",
    "jobcard.total": formatZAR(total),
    "jobcard.parts": formatZAR(parts),
    "jobcard.labour": formatZAR(labour),
    "jobcard.other": formatZAR(other),
    vehicle: jc.vehicle.model,
    "vehicle.vin": jc.vehicle.vin ?? "—",
    "vehicle.reg": jc.vehicle.regNumber ?? "—",
    "vehicle.color": jc.vehicle.color ?? "—",
    technician: jc.technician?.name ?? "—",
  };
  const items: TableRow[] = jc.items.map((i) => ({
    cells: [
      { value: `${i.kind === "labour" ? "Labour — " : ""}${i.description}` },
      { value: String(i.qty) },
      { value: formatZAR(i.unitPriceCents) },
      { value: formatZAR(jobLineCents(i)) },
    ],
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
    },
    customer: { name: tokens["customer.name"], email: tokens["customer.email"], phone: tokens["customer.phone"] },
    vehicle: { model: jc.vehicle.model, vin: jc.vehicle.vin ?? "", reg: jc.vehicle.regNumber ?? "" },
  };
  return { tokens, items, vars };
}

/** Block arrays that live inside a block's props (Puck slot fields). */
const SLOT_KEYS = ["left", "right", "content"];
type Block = { type: string; props: Record<string, unknown> };

/**
 * Walk the block tree: drop Conditional blocks whose expression is false, recurse
 * into every slot, and inject the record's line-items into LineItems blocks —
 * wherever they sit (top level, a column, inside a surviving conditional).
 */
function processBlocks(blocks: unknown, ctx: MergeContext): Block[] {
  const arr = Array.isArray(blocks) ? (blocks as Block[]) : [];
  const out: Block[] = [];
  for (const b of arr) {
    if (!b || typeof b !== "object") continue;
    const props = (b.props ?? {}) as Record<string, unknown>;
    if (b.type === "Conditional") {
      if (!evaluateCondition(String(props.when ?? ""), ctx.vars)) continue; // prune
    }
    for (const key of SLOT_KEYS) {
      if (Array.isArray(props[key])) props[key] = processBlocks(props[key], ctx);
    }
    if (b.type === "LineItems") props.rows = ctx.items;
    out.push(b);
  }
  return out;
}

export function resolveBuilderData(data: BuilderData, ctx: MergeContext): BuilderData {
  const replace = (str: string) => str.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => ctx.tokens[k] ?? "");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return replace(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  const cloned = walk(data) as BuilderData;
  cloned.content = processBlocks(cloned.content, ctx) as BuilderData["content"];
  return cloned;
}
