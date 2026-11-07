/**
 * Multi-currency — the PURE rules (no data, client-safe).
 *
 * A workspace has a BASE currency (Settings → Quotes, Regional.currency). With the
 * `multicurrency` module granted, an owner may also offer other currencies; a lead and
 * its quotes then carry their own `currency`. NULL on a record always means the base
 * currency, so every row written before this — and every workspace without the
 * module — reads exactly as it did.
 *
 * Amounts are stored in the currency they were agreed in and never converted. Totals
 * across records are shown per currency, side by side (no exchange rates).
 */
import { formatZAR, formatZARCompact, type MoneyFormat } from "./format";

/** Offered in Settings as checkboxes (a dropdown, not free text). The base is always included. */
export const COMMON_CURRENCIES = [
  "ZAR", "USD", "EUR", "GBP", "RUB", "AUD", "CAD", "NZD", "CHF", "AED",
  "CNY", "JPY", "INR", "NAD", "BWP", "KES", "NGN", "MZN", "ZMW",
] as const;

/** The base first, then the extra ones the owner ticked — valid ISO codes only, no repeats. */
export function parseEnabledCurrencies(csv: string | null | undefined, base: string): string[] {
  const codes = String(csv ?? "")
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code) && isCurrency(code));
  return [...new Set([base, ...codes])];
}

function isCurrency(code: string): boolean {
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: code });
    return true;
  } catch {
    return false;
  }
}

/** A record's currency: its own, or the base when it has none (NULL = base). */
export function currencyOf(record: { currency?: string | null } | null | undefined, base: string): string {
  return record?.currency || base;
}

/** The workspace's money format (or full Regional), in a record's currency. NULL = unchanged (the base). */
export function withCurrency<F extends MoneyFormat>(format: F, currency: string | null | undefined): F {
  return currency && currency !== format.currency ? { ...format, currency } : format;
}

/**
 * What to STORE for a picked currency: NULL for the base (so the record follows the base, as
 * before), the code otherwise. Refuses a code the workspace doesn't offer.
 */
export function storedCurrency(
  picked: string | null | undefined,
  options: { base: string; enabled: readonly string[] },
): { ok: true; currency: string | null } | { ok: false; error: string } {
  const code = String(picked ?? "").trim().toUpperCase();
  if (!code || code === options.base) return { ok: true, currency: null };
  if (!options.enabled.includes(code)) return { ok: false, error: `${code} isn't one of this workspace's currencies.` };
  return { ok: true, currency: code };
}

/** Sum amounts per currency, base first — the only honest total across currencies without rates. */
export function totalsByCurrency<T>(
  rows: readonly T[],
  pick: (row: T) => { cents: number; currency: string | null | undefined },
  base: string,
): { currency: string; cents: number }[] {
  const totals = new Map<string, number>([[base, 0]]);
  for (const row of rows) {
    const { cents, currency } = pick(row);
    const code = currency || base;
    totals.set(code, (totals.get(code) ?? 0) + cents);
  }
  return [...totals].map(([currency, cents]) => ({ currency, cents })).filter((row, index) => index === 0 || row.cents !== 0);
}

/**
 * A total as ONE base-currency number (what charts, targets and scores need) plus the
 * other currencies kept apart — so nothing is ever added across currencies, and
 * `othersText` can say what the number leaves out.
 */
export function baseAndOthers<T>(
  rows: readonly T[],
  pick: (row: T) => { cents: number; currency: string | null | undefined },
  base: string,
): { baseCents: number; others: { currency: string; cents: number }[] } {
  const [first, ...others] = totalsByCurrency(rows, pick, base);
  return { baseCents: first.cents, others };
}

/** " + ₽ 4,861" per currency a base total leaves out; "" when there are none. */
export function othersText(others: readonly { currency: string; cents: number }[], format: MoneyFormat, compact = false): string {
  return others.length ? ` + ${formatTotals(others, format, compact)}` : "";
}

/** Per-currency totals as text, base first: "R 120,000 + ₽ 4,861". */
export function formatTotals(totals: readonly { currency: string; cents: number }[], format: MoneyFormat, compact = false): string {
  const fmt = compact ? formatZARCompact : formatZAR;
  return totals.map((total) => fmt(total.cents, withCurrency(format, total.currency))).join(" + ");
}

/**
 * A lead's value as it counts toward a single base-currency figure: the value when stored
 * in the base (NULL — the base is never stored as a code), 0 otherwise. The SAME rule as
 * the report buckets (statistics.ts LEAD_BASE_VALUE), so the live and bucket paths agree.
 */
export function baseValueCents(row: { valueCents: number; currency?: string | null }): number {
  return row.currency ? 0 : row.valueCents;
}

/** Per-currency totals of the leads NOT in the base (a set `currency`) — what a base figure leaves out. */
export function nonBaseTotals(rows: readonly { valueCents: number; currency?: string | null }[]): { currency: string; cents: number }[] {
  const totals = new Map<string, number>();
  for (const row of rows) if (row.currency) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.valueCents);
  return [...totals].map(([currency, cents]) => ({ currency, cents }));
}

/** Is this record in the base currency? (NULL = the base.) */
export function inBaseCurrency(record: { currency?: string | null }, base: string): boolean {
  return !record.currency || record.currency === base;
}

type StageLead = {
  valueCents: number;
  currency?: string | null;
  stage: { id: string; name: string; color: string; order: number };
};

/**
 * Open deals per stage, in stage order. EVERY deal counts — a RUB-only pipeline still
 * has deals — but only base-currency values are summed, since one figure can't add currencies.
 */
export function stageSegments(leads: readonly StageLead[], base: string) {
  const byStage = new Map<string, { name: string; color: string; count: number; value: number; order: number }>();
  for (const lead of leads) {
    const seg = byStage.get(lead.stage.id) ?? { name: lead.stage.name, color: lead.stage.color, count: 0, value: 0, order: lead.stage.order };
    seg.count += 1;
    if (inBaseCurrency(lead, base)) seg.value += lead.valueCents;
    byStage.set(lead.stage.id, seg);
  }
  return [...byStage.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...seg }) => seg);
}

/**
 * A quote line's cost in the editor when the draft is in `currency`: the cost as last SAVED, but only
 * in the currency it was saved in — the save drops it on a currency change (itemRowsFor keepCost), so
 * the preview must too. `savedCurrency` and `savedCostCents` move on with every save, so a quote saved
 * in USD (cost cleared) and switched back to ZAR in the same sitting shows no cost, as the server will.
 */
export function editorCostCents(line: { savedCostCents: number }, currency: string, savedCurrency: string): number {
  return currency === savedCurrency ? line.savedCostCents : 0;
}

type PricedBefore = {
  items: readonly { unitPriceCents: number }[];
  fees: readonly { amountCents: number }[];
  depositType: string | null;
  depositValue: number | null;
};
type PricedAfter = {
  items: readonly { id?: string | null; description: string; unitPriceCents: number }[];
  fees: readonly { id?: string | null; label: string; amountCents: number }[];
  depositType?: string | null;
  depositValue?: number | null;
};

/**
 * A draft quote moving to another currency: the first amount still carrying an OLD number
 * (any non-zero figure the quote had before), named for the refusal — or null when everything
 * was re-entered. The editor clears them on a currency change; this is the server holding it.
 * Matched by VALUE, not row id: a caller can drop or change the ids, it can't keep the number.
 * ponytail: a re-entered price that happens to equal an old one is refused too; the person
 * adjusts it by a cent. Per-row tracking only if that ever bites.
 */
export function unrepricedAmount(before: PricedBefore, after: PricedAfter): string | null {
  const prices = new Set(before.items.map((item) => item.unitPriceCents).filter(Boolean));
  const item = after.items.find((row) => prices.has(row.unitPriceCents));
  if (item) return `price for “${item.description}”`;
  const amounts = new Set(before.fees.map((fee) => fee.amountCents).filter(Boolean));
  const fee = after.fees.find((row) => amounts.has(row.amountCents));
  if (fee) return `amount for “${fee.label}”`;
  if (before.depositType === "amount" && after.depositType === "amount" && before.depositValue && after.depositValue === before.depositValue) {
    return "deposit amount";
  }
  return null;
}
