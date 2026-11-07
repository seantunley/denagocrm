/**
 * A rand amount TYPED BY A PERSON, read strictly — for forms that record money
 * actually received (payments, deposits).
 *
 * `parseRands()` (format.ts) strips every comma, so the South African way of
 * writing cents — "1000,50", "1 000,50" — became R100 050,00, and on a big
 * enough invoice that passed the "not more than owing" check and was stored as
 * money received (review of #924). This parser understands both everyday
 * formats and REFUSES anything whose meaning it would have to guess:
 *
 *   accepted                     rand value
 *   1000 · 1000.5 · 1000,50      1 000.00 · 1 000.50 · 1 000.50
 *   1 000 · 1 000,50 · 1 000.50  space-grouped thousands, either decimal mark
 *   1,000 · 1,000.50             comma-grouped thousands, full-stop decimal
 *   R 1 000,50 · ZAR1000         a leading R / ZAR is ignored
 *
 *   refused                      why
 *   1.000 · 1.000,50             full-stop thousands (European) — 1 or 1 000?
 *   1,000,50 · 12,34,567         mis-grouped digits
 *   1000.505                     more than two decimal places
 *   -500 · abc · empty           not an amount received
 *
 * Pure and client-safe. Returns integer cents within Postgres INTEGER, which is
 * what every money column in this schema is.
 */

/** The largest value an INTEGER cents column holds: R21 474 836,47. */
export const MAX_MONEY_CENTS = 2_147_483_647;

export const MONEY_FORMAT_HINT = "Enter the amount like 1 000,50 or 1000.50";

export type MoneyParse = { ok: true; cents: number } | { ok: false; error: string };

const PLAIN = /^(\d+)(?:[.,](\d{1,2}))?$/; //               1000 · 1000.50 · 1000,50
const SPACE_GROUPED = /^(\d{1,3}(?: \d{3})+)(?:[.,](\d{1,2}))?$/; // 1 000 · 1 000,50 · 1 000.50
const COMMA_GROUPED = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/; //   1,000 · 1,000.50

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a person may type around an amount in `currency`: its ISO code and its
 * symbols (₽, $, €…), plus R for the rand. Longest first, so "US$" wins over "$".
 */
function currencyMarks(currency: string): string[] {
  const code = currency.toUpperCase();
  const marks = new Set<string>([code]);
  if (code === "ZAR") marks.add("R");
  // "en" gives "$" for the US dollar; "en-ZA" gives "US$". Both are how people write it.
  for (const locale of ["en", "en-ZA"]) {
    for (const currencyDisplay of ["narrowSymbol", "symbol"] as const) {
      try {
        const symbol = new Intl.NumberFormat(locale, { style: "currency", currency: code, currencyDisplay })
          .formatToParts(1)
          .find((part) => part.type === "currency")?.value;
        if (symbol) marks.add(symbol);
      } catch {
        // Not a currency Intl knows: the code alone is accepted.
      }
    }
  }
  return [...marks].sort((a, b) => b.length - a.length);
}

/**
 * `currency` is the workspace's (Regional.currency); its code or symbol is ignored
 * before or after the number — "₽4 861", "4 861 ₽", "RUB 4861". Defaults to the
 * rand, which is what every caller meant before workspaces had a currency.
 */
export function parseMoneyInput(raw: string | null | undefined, currency = "ZAR"): MoneyParse {
  const marks = currencyMarks(currency).map(escapeRegExp).join("|");
  const value = String(raw ?? "")
    // Non-breaking, narrow and thin spaces are how a pasted "1 000" usually arrives.
    .replace(/[    ]/g, " ")
    .trim()
    .replace(new RegExp(`^(?:${marks})\\s?`, "i"), "")
    .replace(new RegExp(`\\s?(?:${marks})$`, "i"), "")
    .trim();
  if (!value) return { ok: false, error: "Enter the amount received." };

  const match = PLAIN.exec(value) ?? SPACE_GROUPED.exec(value) ?? COMMA_GROUPED.exec(value);
  if (!match) return { ok: false, error: `“${String(raw).trim()}” isn't a clear amount. ${MONEY_FORMAT_HINT}.` };

  const rands = match[1].replace(/[ ,]/g, "").replace(/^0+(?=\d)/, "");
  // Ten digits of rands is already far beyond the column; stop before Number loses precision.
  if (rands.length > 10) return { ok: false, error: "That amount is too large." };
  const cents = Number(rands) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (cents > MAX_MONEY_CENTS) return { ok: false, error: "That amount is too large." };
  return { ok: true, cents };
}

/**
 * A money FIELD on a form — a price, a deal value, a rate. Blank means "none"
 * (`cents: null`; the caller decides whether that is 0 or empty). Anything typed
 * must be a clear amount, read as `parseMoneyInput` reads it.
 *
 * This replaces `parseRands` on every form that took money: that one deleted every
 * character but digits, "." and "-", so "4 861,00" was stored as 486 100 and
 * "1.200.000" as 1.20 — silently, with no way for the person to know.
 */
export function parseMoneyField(
  raw: string | null | undefined,
  currency = "ZAR",
): { ok: true; cents: number | null } | { ok: false; error: string } {
  if (!String(raw ?? "").trim()) return { ok: true, cents: null };
  return parseMoneyInput(raw, currency);
}
