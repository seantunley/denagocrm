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
