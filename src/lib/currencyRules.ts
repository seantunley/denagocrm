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
import type { MoneyFormat } from "./format";

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
