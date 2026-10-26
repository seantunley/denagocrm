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
 * ponytail: amounts and quote numbers everywhere; dates only as a quote's
 * delivery date (below) — other dates, counts and names vary too much in
 * wording to match without false alarms. Add one when 👎 "Wrong facts"
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

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const WORD_SCALES: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9 };
/**
 * Amounts written in WORDS — "six thousand five hundred rand" is R6 500 (Sean, 2026-10-23: a voice note gave the
 * Hermanus fee that way, and DAX flagged the very number he had said). Each run of number words is one amount;
 * "and" and hyphens may sit inside a run ("two hundred and thirty-five thousand").
 */
export function wordAmounts(text: string): number[] {
  const out: number[] = [];
  let total = 0, current = 0, inRun = false;
  const finish = () => { if (inRun) out.push(total + current); total = 0; current = 0; inRun = false; };
  for (const raw of text.toLowerCase().split(/[\s,-]+/)) {
    const word = raw.replace(/[^a-z]/g, "");
    if (word in UNITS) { current += UNITS[word]; inRun = true; }
    else if (word === "hundred" && inRun) current *= 100;
    else if (word in WORD_SCALES && inRun) { total += (current || 1) * WORD_SCALES[word]; current = 0; }
    else if (word === "and" && inRun) continue;
    else finish();
  }
  finish();
  return out;
}

/** Every number in the results — values, numbers inside formatted strings (in digits or in words), and each list's column totals. */
function knownNumbers(data: unknown, into: number[] = []): number[] {
  if (typeof data === "number") into.push(data);
  else if (typeof data === "string") {
    for (const m of data.match(NUMBER) ?? []) { const n = readNumber(m); if (n) into.push(n.value); }
    into.push(...wordAmounts(data));
  }
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

/* ── Checked against THE RECORD the sentence is about (DAX roadmap, Phase 2) ──
 *
 * "This figure is somewhere in the lookups" let a mix-up through: Ben's R 88 500
 * written as Anna's quote, or delivery "R5 000" taken from an old message when
 * the quote itself says R6 500. So a sentence that names a quote — its number,
 * its [[/quotes/…]] link, or "<customer>'s quote" — is checked against THAT
 * quote only: price → its lines, fees and total; "deposit paid" → its deposit;
 * a delivery date → its delivery date. "In stock" → the named unit's status.
 * And an email is never "delivered" or "read" — the CRM can't know either.
 *
 * Not bound (checked as before, against everything): a sentence reporting what
 * someone SAID ("he wrote R5 000"), or proposing a change ("I'll set delivery
 * to R6 500") — those figures are not the record's, by design.
 *
 * ponytail: a sentence naming two quotes is checked against both together, so
 * a figure swapped between them passes. Bind per clause when that shows up.
 */

/** What one quote holds, merged across every lookup that returned it (keyed by its link). */
type QuoteRecord = { quote: string; customers: Set<string>; numbers: number[]; total: number | null; paid: boolean; delivery: Set<string> };
type StockRecord = { link: string; unit: string; product: string; status: string };

/** Customer words inside a quote's row — never the quote's own facts. */
const TALK_KEYS = new Set(["messages", "notes", "note", "research", "text", "reason", "changeRequested", "activities", "otherMatches", "customerRecordsNote", "matched"]);
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?![a-z])|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
/** Each date in `text` as "MM-DD" (year left out: answers rarely write it), with how it was written. */
function datesIn(text: string): { key: string; written: string }[] {
  return [...text.matchAll(DATE)].map((m) => {
    const [month, day] = m[1] ? [Number(m[2]), Number(m[3])] : m[4] ? [MONTHS.indexOf(m[5].toLowerCase()) + 1, Number(m[4])] : [MONTHS.indexOf(m[6].toLowerCase()) + 1, Number(m[7])];
    return { key: `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, written: m[0].trim().replace(/\.$/, "") };
  });
}
const stringsIn = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(stringsIn) : v && typeof v === "object" ? Object.values(v).flatMap(stringsIn) : [];
const withoutTalk = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !TALK_KEYS.has(k)));
const amount = (v: unknown) => (typeof v === "string" && /^\s*R/.test(v) ? readNumber(v.replace(/^\s*R\s*/, ""))?.value ?? null : null);

/** Every quote and stock unit in the lookups, with the customer each quote sits under. */
function recordsIn(sources: unknown[]) {
  const quotes = new Map<string, QuoteRecord>();
  const stock: StockRecord[] = [];
  const walk = (v: unknown, customer: string | null) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, customer));
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    // A quote row names its customer; one inside a lead brief or a customer record sits under theirs.
    const who = typeof o.customer === "string" ? o.customer : typeof o.name === "string" ? o.name : customer;
    const link = typeof o.link === "string" ? o.link : "";
    if (link.startsWith("/quotes/") && typeof o.quote === "string") {
      const own = withoutTalk(o);
      const r = quotes.get(link) ?? { quote: o.quote.replace(/^Q-?/i, ""), customers: new Set<string>(), numbers: [], total: null, paid: false, delivery: new Set<string>() };
      if (who) r.customers.add(who);
      r.numbers.push(...knownNumbers(own));
      r.total ??= amount(o.total);
      if (typeof o.deposit === "string" && /^paid\b/i.test(o.deposit)) r.paid = true;
      for (const key of ["deliveryDate", "delivered", "delivery"]) for (const d of datesIn(stringsIn(o[key]).join(" "))) r.delivery.add(d.key);
      quotes.set(link, r);
    }
    if (link.startsWith("/stock/") && typeof o.status === "string") {
      stock.push({ link, unit: String(o.unit ?? ""), product: String(o.product ?? ""), status: o.status.toLowerCase() });
    }
    for (const [k, x] of Object.entries(o)) if (!TALK_KEYS.has(k) && x && typeof x === "object") walk(x, who);
  };
  walk(sources, null);
  return { quotes: [...quotes.entries()].map(([link, r]) => ({ link, ...r })), stock };
}

/** Someone's words being reported — not a claim about the record. */
const REPORTED = /\b(said|says|wrote|writes|asked|asks|mentioned|messaged|message|promised|told|tells|offered|budget|limit|wanted|wants|hoped|hopes|expects?|expected|claimed|according)\b/i;
/** A change being proposed — its figures are the new values, not the record's. */
const PROPOSAL = /\b(I'll|I will|I'd|I would|I've (?:drafted|prepared|set|added|changed|made|updated)|draft(?:ed)?|propos(?:e|ed|al)|shall I|should I|want me|confirm|change(?: it| the| that)? to|update(?: it| the)? to|set (?:it|the|delivery|the delivery) to|new quote|would|could|instead)\b/i;
const NEGATED = /n't\b|\b(not|no|never|none|unpaid|outstanding|awaiting|still|yet|until|once|before|if|out of)\b/i;
const word = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
/** "Anna Jacobs" is named by "Anna Jacobs" or "Anna" (a first name of 3+ letters). */
function names(text: string, customers: Set<string>): boolean {
  for (const c of customers) {
    const full = c.trim();
    if (!full || /^(no|a) customer$/i.test(full)) continue;
    const first = full.split(/\s+/)[0];
    if (word(full).test(text) || (first.length >= 3 && word(first).test(text))) return true;
  }
  return false;
}

/** "the email was delivered" / "she read your email" — the CRM can only know accepted, bounced or opened. */
const EMAIL_CLAIM = /\be-?mail\w*\b[^.,;:!?]{0,40}?\b(delivered|read|received)\b|\b(read|received)\b[^.,;:!?]{0,25}?\be-?mail/i;

/**
 * The amounts and quote numbers in `answer` that nothing in `sources` (the
 * lookups' data, the question, the earlier conversation) supports, as written —
 * and, where a sentence names a record, the facts that record doesn't hold.
 * `answer` may still carry its [[/link]] citations: they say which record a sentence cites.
 */
export function unsupportedFigures(answer: string, sources: unknown[]): string[] {
  const numbers = knownNumbers(sources);
  const quotes = quoteNumbers(sources);
  const records = recordsIn(sources);
  const near = (pool: number[], value: number, slack: number) => pool.some((n) => Math.abs(n - value) <= slack);
  const flagged: string[] = [];
  const sentences = answer
    .split("\n")
    .filter((line) => !/^\s*[-•]?\s*My read:/i.test(line))
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/));
  for (const sentence of sentences) {
    const cites = new Set([...sentence.matchAll(/\[\[\s*(\/[^\]\s]{1,200})\s*\]\]/g)].map((m) => m[1]));
    const text = sentence.replace(/\[\[[^\]]*\]\]/g, "");
    const named = new Set([...text.matchAll(QUOTE)].map((m) => m[1]));
    const aboutQuote = named.size > 0 || [...cites].some((c) => c.startsWith("/quotes/")) || /\bquot(e|es|ed|ation)\b/i.test(text);
    const free = REPORTED.test(text) || PROPOSAL.test(text);
    const bound = free || !aboutQuote ? [] : records.quotes.filter((r) => cites.has(r.link) || named.has(r.quote) || names(text, r.customers));
    const boundNumbers = [...bound.flatMap((r) => r.numbers), bound.reduce((sum, r) => sum + (r.total ?? 0), 0)];
    const on = bound.map((r) => `Q-${r.quote}`).join("/");

    for (const m of text.matchAll(MONEY)) {
      const read = readNumber(m[1]);
      if (!read) continue;
      const scale = m[2] ? SCALE[m[2].toLowerCase()] : 1;
      const value = read.value * scale;
      // Rounded as written ("R1.2m" is anything from 1.15m to 1.25m), or within 1%.
      const slack = Math.max((read.unit * scale) / 2, value * 0.01, 0.5);
      if (!near(numbers, value, slack)) flagged.push(m[0].trim());
      // In the records, but not on the quote this sentence is about: a mix-up.
      else if (bound.length && !near(boundNumbers, value, slack)) flagged.push(`${m[0].trim()} (not on ${on})`);
    }
    for (const m of text.matchAll(QUOTE)) if (!quotes.has(m[1])) flagged.push(`Q-${m[1]}`);
    if (free) continue;

    if (bound.length && /\bdeposit\b/i.test(text) && /\bpaid\b/i.test(text) && !NEGATED.test(text) && !bound.some((r) => r.paid)) {
      flagged.push(`deposit paid (not on ${on})`);
    }
    // Dates written after "deliver…": "signed 3 Oct, delivery not booked" names no delivery date.
    const deliverAt = text.search(/\bdeliver/i);
    const dates = deliverAt < 0 ? [] : datesIn(text.slice(deliverAt));
    if (bound.length && dates.length && !dates.some((d) => bound.some((r) => r.delivery.has(d.key)))) {
      flagged.push(`delivery ${dates[0].written} (not on ${on})`);
    }
    if (/\b(in stock|available)\b/i.test(text) && !NEGATED.test(text)) {
      const units = records.stock.filter((u) => cites.has(u.link) || (u.unit && word(u.unit).test(text)) || (u.product.length >= 3 && word(u.product).test(text)));
      if (units.length && !units.some((u) => u.status === "available")) flagged.push(`in stock (${units[0].product || units[0].unit} is ${units[0].status})`);
    }
    const email = EMAIL_CLAIM.exec(text);
    if (email && !/n't\b|\b(not|never|no|bounced|undelivered|refused)\b/i.test(text)) {
      flagged.push(`email "${(email[1] ?? email[2]).toLowerCase()}" (the CRM can only tell accepted, bounced or opened)`);
    }
  }
  return [...new Set(flagged)];
}

/** The line added under an answer with unsupported figures — shown, never hidden. */
export function unsupportedNote(flagged: string[]): string {
  const list = flagged.slice(0, 4).join(", ") + (flagged.length > 4 ? ` and ${flagged.length - 4} more` : "");
  return `⚠️ Not found in the CRM records: ${list}. ${flagged.length === 1 ? "It may be" : "They may be"} worked out from them, or wrong — check before relying on ${flagged.length === 1 ? "it" : "them"}.`;
}
