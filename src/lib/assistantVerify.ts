/**
 * The free check on every answer: each rand amount and quote number DAX writes
 * must be in what the CRM returned (or in what the person said). Invented
 * figures and a mixed-up quote are the most damaging mistakes it can make, and
 * this costs no model call — a second "verifier" pass would add 4–8s and still
 * be the same model marking its own homework.
 *
 * It flags, it doesn't delete: a figure can be honestly worked out from the
 * results (a total the person asked for), so the answer keeps it and says
 * plainly it isn't in the records. Lines DAX labelled as its own judgement
 * ("My read:") are opinion by definition and aren't checked.
 *
 * ponytail: amounts and quote numbers only — dates, counts and names vary too
 * much in wording to match without false alarms. Add one when 👎 "Wrong facts"
 * feedback shows that kind of mistake getting through.
 */

const MONEY = /\bR\s?(\d[\d\s  ,.]*\d|\d)\s?(k|m|bn|million|thousand)?\b/gi;
const QUOTE = /\bQ-?(\d{2,})\b/gi;
const NUMBER = /\d[\d\s  ,.]*\d|\d/g;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9 };

/** "12 345,50", "12,345.50", "1.2" → the number and the size of its last written digit. */
function readNumber(text: string): { value: number; unit: number } | null {
  const digits = text.replace(/[\s  ]/g, "");
  // A final , or . followed by one or two digits is the decimal point; every
  // other separator groups thousands (en-ZA writes "R 12 345,50").
  const decimal = /[.,](\d{1,2})$/.exec(digits);
  const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole)) return null;
  const value = Number(`${whole}${decimal ? `.${decimal[1]}` : ""}`);
  return { value, unit: decimal ? 10 ** -decimal[1].length : 1 };
}

/** Every number in the results — values, numbers inside formatted strings, and each list's column totals. */
function knownNumbers(data: unknown, into: number[] = []): number[] {
  if (typeof data === "number") into.push(data);
  else if (typeof data === "string") for (const m of data.match(NUMBER) ?? []) { const n = readNumber(m); if (n) into.push(n.value); }
  else if (Array.isArray(data)) {
    data.forEach((item) => knownNumbers(item, into));
    // "Your three open quotes come to R 412 000": a sum of one field across a list.
    const sums = new Map<string, number>();
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      for (const [key, v] of Object.entries(item)) {
        const n = typeof v === "number" ? v : typeof v === "string" && /^\s*R/.test(v) ? readNumber(v.replace(/^\s*R\s*/, ""))?.value : undefined;
        if (n !== undefined) sums.set(key, (sums.get(key) ?? 0) + n);
      }
    }
    into.push(...sums.values());
  } else if (data && typeof data === "object") for (const v of Object.values(data)) knownNumbers(v, into);
  return into;
}

function quoteNumbers(data: unknown, into = new Set<string>()): Set<string> {
  if (typeof data === "string") for (const m of data.matchAll(QUOTE)) into.add(m[1]);
  else if (Array.isArray(data)) data.forEach((v) => quoteNumbers(v, into));
  else if (data && typeof data === "object") for (const v of Object.values(data)) quoteNumbers(v, into);
  return into;
}

/**
 * The amounts and quote numbers in `answer` that nothing in `sources` (the
 * lookups' data, the question, the earlier conversation) supports, as written.
 */
export function unsupportedFigures(answer: string, sources: unknown[]): string[] {
  const checked = answer.split("\n").filter((line) => !/^\s*[-•]?\s*My read:/i.test(line)).join("\n");
  const numbers = knownNumbers(sources);
  const quotes = quoteNumbers(sources);
  const flagged: string[] = [];
  for (const m of checked.matchAll(MONEY)) {
    const read = readNumber(m[1]);
    if (!read) continue;
    const scale = m[2] ? SCALE[m[2].toLowerCase()] : 1;
    const value = read.value * scale;
    // Rounded as written ("R1.2m" is anything from 1.15m to 1.25m), or within 1%.
    const slack = Math.max((read.unit * scale) / 2, value * 0.01, 0.5);
    if (!numbers.some((n) => Math.abs(n - value) <= slack)) flagged.push(m[0].trim());
  }
  for (const m of checked.matchAll(QUOTE)) if (!quotes.has(m[1])) flagged.push(`Q-${m[1]}`);
  return [...new Set(flagged)];
}

/** The line added under an answer with unsupported figures — shown, never hidden. */
export function unsupportedNote(flagged: string[]): string {
  const list = flagged.slice(0, 4).join(", ") + (flagged.length > 4 ? ` and ${flagged.length - 4} more` : "");
  return `⚠️ Not found in the CRM records: ${list}. ${flagged.length === 1 ? "It may be" : "They may be"} worked out from them, or wrong — check before relying on ${flagged.length === 1 ? "it" : "them"}.`;
}
