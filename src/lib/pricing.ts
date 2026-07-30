/**
 * Canonical quote pricing. Every surface that shows a quote line or quote
 * total — list, detail, leads, deliveries, print documents, the signing
 * snapshot, reports — must compute money through these helpers so a per-line
 * discount is applied identically everywhere. Do not recompute
 * `qty * unitPriceCents` inline.
 */

export type PricedLine = {
  qty: number;
  unitPriceCents: number;
  discountPct?: number | null;
  // CPQ
  taxRatePct?: number | null;
  costCents?: number | null;
  optional?: boolean | null;
  selected?: boolean | null;
};

/** Effective (discounted) line amount in cents (gross when tax-inclusive). */
export function lineNetCents(line: PricedLine): number {
  const discount = Math.min(100, Math.max(0, line.discountPct ?? 0));
  return Math.round(line.qty * line.unitPriceCents * (1 - discount / 100));
}

/** Whether a line counts toward the total (optional add-ons only when selected). */
export function isLineIncluded(line: PricedLine): boolean {
  return !line.optional || line.selected !== false;
}

/**
 * The lines a document should PRINT — exactly the ones its total counts.
 *
 * An optional add-on the customer didn't take is excluded from the total by
 * quotePricing, so printing it anyway put an apparently-charged line on the
 * page that the total never included. Every renderer takes its rows from here,
 * so the two can't drift apart again.
 */
export function includedLines<T extends PricedLine>(lines: T[]): T[] {
  return lines.filter(isLineIncluded);
}

/** Sum of the discounted line amounts for the included lines, in cents. */
export function quoteTotalCents(lines: PricedLine[]): number {
  return lines.reduce((sum, line) => (isLineIncluded(line) ? sum + lineNetCents(line) : sum), 0);
}

// ── CPQ pricing engine ────────────────────────────────────────────────────────
export type FeeLine = { amountCents: number; taxRatePct?: number | null };

export type PricingOpts = {
  taxInclusive?: boolean; // default true — unit prices already include VAT
  depositType?: string | null; // percent | amount
  depositValue?: number | null; // % when percent, rands when amount
};

export type QuotePricing = {
  netCents: number; // ex-tax subtotal (lines + fees)
  taxCents: number;
  totalCents: number; // incl tax
  feesTotalCents: number; // fees, incl tax
  costCents: number; // total line cost
  marginCents: number; // line net − cost (fees excluded from cost)
  marginPct: number;
  depositCents: number;
  balanceCents: number;
};

/** Split an amount into net + tax, honouring inclusive vs exclusive pricing. */
export function splitTax(amountCents: number, ratePct: number | null | undefined, inclusive: boolean): { net: number; tax: number; total: number } {
  const rate = Math.max(0, ratePct ?? 0) / 100;
  if (inclusive) {
    const net = Math.round(amountCents / (1 + rate));
    return { net, tax: amountCents - net, total: amountCents };
  }
  const tax = Math.round(amountCents * rate);
  return { net: amountCents, tax, total: amountCents + tax };
}

/** Full financial breakdown for a quote: tax, fees, cost/margin and deposit. */
export function quotePricing(lines: PricedLine[], fees: FeeLine[] = [], opts: PricingOpts = {}): QuotePricing {
  const inclusive = opts.taxInclusive !== false;
  let net = 0;
  let tax = 0;
  let cost = 0;
  let lineNet = 0;

  for (const line of lines) {
    if (!isLineIncluded(line)) continue;
    const s = splitTax(lineNetCents(line), line.taxRatePct ?? 15, inclusive);
    net += s.net;
    tax += s.tax;
    lineNet += s.net;
    cost += Math.round(line.qty * (line.costCents ?? 0));
  }

  let feesTotal = 0;
  for (const fee of fees) {
    const s = splitTax(fee.amountCents, fee.taxRatePct ?? 15, inclusive);
    net += s.net;
    tax += s.tax;
    feesTotal += s.total;
  }

  const totalCents = net + tax;
  const marginCents = lineNet - cost;
  const marginPct = lineNet > 0 ? Math.round((marginCents / lineNet) * 100) : 0;

  let depositCents = 0;
  if (opts.depositType === "percent" && opts.depositValue) depositCents = Math.round((totalCents * opts.depositValue) / 100);
  else if (opts.depositType === "amount" && opts.depositValue) depositCents = Math.round(opts.depositValue * 100);
  depositCents = Math.max(0, Math.min(depositCents, totalCents));

  return {
    netCents: net,
    taxCents: tax,
    totalCents,
    feesTotalCents: feesTotal,
    costCents: cost,
    marginCents,
    marginPct,
    depositCents,
    balanceCents: totalCents - depositCents,
  };
}

// ── One payable total, for every customer-facing surface ──────────────────────

/**
 * What the customer actually pays: line items PLUS fees and delivery.
 *
 * `quoteTotalCents(items)` is the line-items subtotal and is NOT this. Every
 * customer-facing and legal surface — the printed quote, the sales agreement,
 * the signing envelope, the audit trail — used the subtotal, so a quote carrying
 * a R5 500 delivery charge showed R545 500 on the deliveries board while the
 * document the customer signed said R540 000.
 *
 * Fees are not optional in the data model, so nothing that states a price to a
 * customer should be computing it any other way. Use this.
 */
export function payableTotalCents(quote: {
  items: PricedLine[];
  fees?: FeeLine[] | null;
  taxInclusive?: boolean | null;
  depositType?: string | null;
  depositValue?: number | null;
}): number {
  return quotePricing(quote.items, quote.fees ?? [], {
    taxInclusive: quote.taxInclusive ?? undefined,
    depositType: quote.depositType,
    depositValue: quote.depositValue,
  }).totalCents;
}

type QuoteMoney = {
  items: PricedLine[];
  fees?: FeeLine[] | null;
  taxInclusive?: boolean | null;
  depositType?: string | null;
  depositValue?: number | null;
};

/** One line of a printed totals block. */
export type TotalLine = { label: string; amountCents: number; strong?: boolean };

/**
 * The totals block for a printed document, built so the rows the customer can
 * SEE always add up to the figure at the bottom.
 *
 * The two tax modes need different blocks, and that is the whole point:
 *
 *   inclusive (default) — row amounts already include VAT, so they sum to the
 *     payable total. One line: "Total incl. VAT".
 *   exclusive — row amounts are ex-VAT, so they sum to the SUBTOTAL. Printing
 *     only "Total incl. VAT" against them showed rows of R110 under a total of
 *     R126.50 with nothing explaining the gap. Three lines, and it reconciles.
 */
export function documentTotals(quote: QuoteMoney): TotalLine[] {
  const pricing = quotePricing(quote.items, quote.fees ?? [], {
    taxInclusive: quote.taxInclusive ?? undefined,
    depositType: quote.depositType,
    depositValue: quote.depositValue,
  });
  if (quote.taxInclusive !== false) {
    return [{ label: "Total incl. VAT", amountCents: pricing.totalCents, strong: true }];
  }
  return [
    { label: "Subtotal", amountCents: pricing.netCents },
    { label: "VAT", amountCents: pricing.taxCents },
    { label: "Total incl. VAT", amountCents: pricing.totalCents, strong: true },
  ];
}

/**
 * Fees rendered as line-item rows, so a printed document ITEMISES the delivery
 * charge rather than folding it silently into the total.
 */
export function feeRows(
  fees: { label: string; kind?: string | null; amountCents: number }[] = [],
): { description: string; qty: number; unitPriceCents: number }[] {
  return fees.map((fee) => ({
    description: fee.kind === "delivery" ? `Delivery — ${fee.label}` : fee.label,
    qty: 1,
    unitPriceCents: fee.amountCents,
  }));
}
