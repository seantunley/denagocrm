/*
 * TEXT WRITTEN FOR THE SCREEN, MADE FIT TO SAY (Sean, 2026-11-02: "the voicenotes don't flow that well and the
 * text to speech sounds very mechanical"). Pure — no database, no ElevenLabs — so every rule is tested.
 *
 * A voice model reads what it is given. "R 185 000,00" came out as digits and commas, "Q-1030" as letters and a
 * minus, and a list as a run of one-word sentences. ElevenLabs' own guidance is to hand the model words, not
 * symbols (docs: best-practices/prompting/normalization). So, before anything is spoken:
 *  - rand amounts become words ("a hundred and eighty-five thousand rand"), in English; in Afrikaans plain digits;
 *  - quote numbers are said as a person says them ("quote ten thirty");
 *  - dates and short day/month names are written out; a few symbols and abbreviations become words;
 *  - a short list is one sentence ("A, B and C."), a long one a sentence per item;
 *  - the workspace's own pronunciations are applied last ("Denago = Deh-NAH-go").
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function underThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const restWords = rest < 20 ? ONES[rest] : `${TENS[Math.floor(rest / 10)]}${rest % 10 ? `-${ONES[rest % 10]}` : ""}`;
  if (!hundreds) return restWords;
  return `${ONES[hundreds]} hundred${rest ? ` and ${restWords}` : ""}`;
}

/** A whole number in British/South African English words ("a hundred and eighty-five thousand"). Up to the billions. */
export function numberWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "zero";
  const groups: [number, string][] = [[1_000_000_000, "billion"], [1_000_000, "million"], [1_000, "thousand"], [1, ""]];
  const parts: string[] = [];
  let left = n;
  for (const [size, name] of groups) {
    const chunk = Math.floor(left / size);
    left %= size;
    if (!chunk) continue;
    // "and" before a last chunk under a hundred: "one thousand and five".
    const words = size === 1 && parts.length && chunk < 100 ? `and ${underThousand(chunk)}` : underThousand(chunk);
    parts.push(name ? `${words} ${name}` : words);
  }
  // "one hundred…" at the very start reads more naturally as "a hundred…".
  return parts.join(" ").replace(/^one (hundred|thousand|million|billion)/, "a $1");
}

/** "R 185 000,00" / "R185,000" / "R185 000.50" → cents, or null when it is not one amount. */
export function randCents(raw: string): number | null {
  const m = /^R\s?(\d{1,3}(?:[  ,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const rands = Number(m[1].replace(/[  ,]/g, ""));
  const cents = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  return Number.isFinite(rands) ? rands * 100 + cents : null;
}

function randWords(cents: number, afrikaans: boolean): string {
  const rands = Math.floor(cents / 100);
  const c = cents % 100;
  if (afrikaans) return `${rands}${c ? `,${String(c).padStart(2, "0")}` : ""} rand`;
  return `${numberWords(rands)} rand${c ? ` and ${numberWords(c)} cents` : ""}`;
}

/** "1030" → "ten thirty"; a number that does not split that way is said whole. */
function quoteNumberWords(digits: string): string {
  const n = Number(digits);
  if (digits.length === 4 && digits[2] !== "0") return `${numberWords(Number(digits.slice(0, 2)))} ${numberWords(Number(digits.slice(2)))}`;
  return numberWords(n);
}

const DAYS: Record<string, string> = { mon: "Monday", tue: "Tuesday", tues: "Tuesday", wed: "Wednesday", thu: "Thursday", thur: "Thursday", thurs: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_SHORT: Record<string, string> = Object.fromEntries(MONTHS.map((m) => [m.slice(0, 3).toLowerCase(), m]));
MONTH_SHORT.sept = "September";

/** Emoji and the invisible bits that glue them together. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}︎️‍⃣]/gu;

/** One line of prose, made sayable: amounts, quote numbers, dates, symbols. */
function sayLine(line: string, afrikaans: boolean): string {
  return line
    // Amounts first, before anything else touches their digits.
    .replace(/R\s?(?:\d{1,3}(?:[  ,]\d{3})+|\d+)(?:[.,]\d{1,2})?(?!\d)/g, (amount) => {
      const cents = randCents(amount);
      return cents == null ? amount : randWords(cents, afrikaans);
    })
    // "quote Q-1030" must not become "quote quote ten thirty".
    .replace(/(\b(?:quote|kwotasie)\s+)?\bQ-?(\d{2,6})\b/gi, (_, said: string | undefined, n: string) =>
      `${said ?? (afrikaans ? "kwotasie " : "quote ")}${afrikaans ? n : quoteNumberWords(n)}`)
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y: string, mo: string, d: string) => {
      const month = MONTHS[Number(mo) - 1];
      return month ? `${Number(d)} ${month} ${y}` : whole;
    })
    // "Mon 2 Nov", "2 Nov", "Nov 2": short names in full.
    // (A full stop after the short name is kept: it may also end the sentence.)
    .replace(/\b(Mon|Tues?|Wed|Thu(?:rs?)?|Fri|Sat|Sun)\b/g, (d: string) => DAYS[d.toLowerCase()] ?? d)
    .replace(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b/g, (_, d: string, m: string) => `${d} ${MONTH_SHORT[m.toLowerCase()] ?? m}`)
    .replace(/\s&\s/g, afrikaans ? " en " : " and ")
    .replace(/\be\.g\.\s?/gi, afrikaans ? "byvoorbeeld " : "for example ")
    .replace(/\bi\.e\.\s?/gi, afrikaans ? "dit wil sê " : "that is ")
    .replace(/\bapprox\.?(?=\s|$)/gi, afrikaans ? "ongeveer" : "about")
    .replace(/\bincl\.?(?=\s|$)/gi, afrikaans ? "insluitend" : "including")
    .replace(/\bexcl\.?(?=\s|$)/gi, afrikaans ? "uitgesluit" : "excluding")
    .replace(/(\d)\s?%/g, afrikaans ? "$1 persent" : "$1 percent")
    .replace(/\s[–—-]\s/g, ", ")
    .replace(/\//g, " or ");
}

/** The workspace's pronunciations (Settings → Integrations → ElevenLabs), one "word = how to say it" per line. */
export const PRONUNCIATIONS_KEY = "ELEVENLABS_PRONUNCIATIONS";

/** "Denago = Deh-NAH-go", one per line → [word, how to say it]. Blank or malformed lines are skipped. */
export function parsePronunciations(raw: string | null | undefined): [string, string][] {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("="))
    .filter((parts) => parts.length === 2 && parts[0].trim() && parts[1].trim())
    .map(([word, say]) => [word.trim().slice(0, 60), say.trim().slice(0, 80)] as [string, string])
    .slice(0, 100);
}

function applyPronunciations(text: string, pronunciations: readonly [string, string][]): string {
  let out = text;
  for (const [word, say] of pronunciations) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu"), say);
  }
  return out;
}

/** A list item short enough to join into one spoken sentence. */
const SHORT_ITEM = 70;

/**
 * Written text → what is said. Markdown, links, evidence markers and emoji go; bullets become a list said as one
 * sentence ("Anna, Ben and Clive.") when the items are short, a sentence each when they are not; every line ends
 * as a sentence; then amounts, quote numbers, dates and the workspace's pronunciations.
 */
export function speakableText(written: string, opts: { afrikaans?: boolean; pronunciations?: readonly [string, string][] } = {}): string {
  const afrikaans = Boolean(opts.afrikaans);
  const lines = String(written ?? "")
    .replace(/\[\[\d+\]\]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(EMOJI, "")
    .replace(/[*`_]{1,2}/g, "")
    .split(/\r?\n/)
    .map((raw) => {
      const bullet = /^\s*(?:[-•–]\s+|\d+[.)]\s+)/.test(raw);
      const text = raw.replace(/^\s*(?:[-•–]\s+|[>#]+\s*|\d+[.)]\s+)/, "").replace(/\s+/g, " ").trim();
      return { bullet, text };
    })
    .filter((line) => /[\p{L}\p{N}]/u.test(line.text));

  const sentences: string[] = [];
  // A lead-in ending in ":" flows into what follows it; anything else ends as a sentence.
  const end = (s: string) => (/[.!?:]$/.test(s) ? s : `${s.replace(/[,;]$/, "")}.`);
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].bullet) {
      sentences.push(end(lines[i].text));
      i++;
      continue;
    }
    const run: string[] = [];
    while (i < lines.length && lines[i].bullet) run.push(lines[i++].text.replace(/[.;,]$/, ""));
    // Joined only when every item is a short, simple phrase: one with its own comma, dash or colon ("Anna Smith —
    // quote viewed twice") would blur into its neighbours, so those are a sentence each.
    if (run.length > 1 && run.every((item) => item.length <= SHORT_ITEM && !/[,;:—–]|\s-\s/.test(item))) {
      const and = afrikaans ? " en " : " and ";
      sentences.push(end(`${run.slice(0, -1).join(", ")}${and}${run[run.length - 1]}`));
    } else {
      for (const item of run) sentences.push(end(item));
    }
  }
  const joined = sentences.join(" ").replace(/\s+([.,!?;:])/g, "$1");
  const said = joined.split(/(?<=[.!?])\s+/).map((s) => sayLine(s, afrikaans)).join(" ");
  return applyPronunciations(said, opts.pronunciations ?? []).replace(/\s{2,}/g, " ").trim();
}
