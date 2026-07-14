import "server-only";
import type { Prisma } from "@prisma/client";
import { contactName, formatDate, formatZAR } from "@/lib/format";
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
  const total = quote.items.reduce((sum, i) => sum + i.qty * i.unitPriceCents, 0);
  // Prices are VAT-inclusive (15%) — derive the breakdown for VAT lines.
  const subtotal = Math.round(total / 1.15);
  const vat = total - subtotal;
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
    "quote.total": formatZAR(Math.round(total)),
    vehicle: quote.lead?.product?.name ?? quote.items[0]?.description ?? "—",
    preparedBy: quote.createdBy?.name ?? "—",
  };
  const items: TableRow[] = quote.items.map((i) => ({
    cells: [
      { value: i.description },
      { value: String(i.qty) },
      { value: formatZAR(i.unitPriceCents) },
      { value: formatZAR(Math.round(i.qty * i.unitPriceCents)) },
    ],
  }));
  // Typed scope for conditional expressions (amounts in rand, not cents).
  const quotation = {
    number: quote.number,
    total: Math.round(total) / 100,
    subtotal: subtotal / 100,
    vat: vat / 100,
    lines: quote.items.map((i) => ({ description: i.description, qty: i.qty, price: i.unitPriceCents / 100 })),
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
  const sum = (kind: string) => jc.items.filter((i) => i.kind === kind).reduce((s, i) => s + i.qty * i.unitPriceCents, 0);
  const parts = sum("part");
  const labour = sum("labour");
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
    "jobcard.total": formatZAR(parts + labour),
    "jobcard.parts": formatZAR(parts),
    "jobcard.labour": formatZAR(labour),
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
      { value: formatZAR(Math.round(i.qty * i.unitPriceCents)) },
    ],
  }));
  const vars = {
    jobcard: {
      number: jc.number,
      status: jc.status,
      total: (parts + labour) / 100,
      parts: parts / 100,
      labour: labour / 100,
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
