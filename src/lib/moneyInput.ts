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

export function parseMoneyInput(raw: string | null | undefined): MoneyParse {
  const value = String(raw ?? "")
    // Non-breaking, narrow and thin spaces are how a pasted "1 000" usually arrives.
    .replace(/[    ]/g, " ")
    .trim()
    .replace(/^(?:ZAR|R)\s?/i, "")
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
