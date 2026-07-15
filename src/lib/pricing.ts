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
};

/** Effective (discounted) line total in cents, discount clamped to 0–100. */
export function lineNetCents(line: PricedLine): number {
  const discount = Math.min(100, Math.max(0, line.discountPct ?? 0));
  return Math.round(line.qty * line.unitPriceCents * (1 - discount / 100));
}

/** Sum of the discounted line totals for a quote, in cents. */
export function quoteTotalCents(lines: PricedLine[]): number {
  return lines.reduce((sum, line) => sum + lineNetCents(line), 0);
}
