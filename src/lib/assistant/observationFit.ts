/**
 * What DAX's research step is shown when a lookup is too big or fails — Scarlet's tool rules, applied (docs/dax-tools-
 * and-learning-audit-2026-11-20.md, gaps 1 and 2): an answer ends at whole records and says how many it left out and
 * how to get them; a failure says which lookup, what kind of failure, and what to do instead. Pure.
 */

/*
 * A lookup's SUMMARY (its totals and notes — find_leads' { total, listed }, find_quotes' { matching }) heads its list.
 * It is marked where it is made, so trimming keeps it whole and never counts it as a record (review of #1157: a summary
 * counted as a lead made "showing 13" mean 12 leads, and "showing 1" none).
 */
const SUMMARIES = new WeakSet<object>();
/** Mark a lookup's summary item. Returns the same object. */
export function summary<T extends object>(item: T): T {
  SUMMARIES.add(item);
  return item;
}
/** How many marked summaries lead this list — read from the lookup's own objects, before they are cleaned or copied. */
export function leadingSummaries(data: unknown): number {
  if (!Array.isArray(data)) return 0;
  let n = 0;
  while (n < data.length && typeof data[n] === "object" && data[n] !== null && SUMMARIES.has(data[n])) n++;
  return n;
}

/**
 * The lookup's results as the model reads them, within `budget` characters. Over budget, whole RECORDS are dropped
 * from the end (the lookups put the most relevant first), the leading `summaries` are always kept, and the model is
 * told "showing N of M" in records only — never JSON cut mid-record with no way to know what was lost. When even the
 * summaries and one record don't fit, it is cut as before.
 */
export function fitObservation(results: unknown, truncated: boolean, budget: number, summaries = 0): string {
  const whole = JSON.stringify({ truncated, results });
  if (whole.length <= budget || !Array.isArray(results) || results.length - summaries < 1) {
    return whole.length > budget ? `${whole.slice(0, budget)}…(cut)` : whole;
  }
  const head = results.slice(0, summaries);
  const records = results.slice(summaries);
  // ponytail: drops one record at a time and re-measures (lists cap at 60 rows, so ≤60 stringifies).
  // With a summary, "0 of M" is honest (the totals still say how many). Without one, at least one record or the cut.
  for (let n = records.length - 1; n >= (summaries ? 0 : 1); n--) {
    const body = JSON.stringify({
      truncated: true,
      showing: `${n} of ${records.length}${truncated ? "+" : ""}`,
      note: `Only the first ${n} records fit${summaries ? " (the summary before them is complete)" : ""}. Narrow the lookup (a stage, person, dates or a smaller limit) to see the rest — never say these are all of them.`,
      results: [...head, ...records.slice(0, n)],
    });
    if (body.length <= budget) return body;
  }
  // ONE object holding the list — signing's { total, listed, requests: [...] }, tickets' { open, …, tickets: [...] }
  // (review of #1157): its longest list of records is trimmed instead, whole records with "<list>Showing: N of M", the
  // object's other fields (totals, notes) kept.
  if (records.length === 1) {
    const nested = trimNestedList(records[0], head, truncated, budget);
    if (nested) return nested;
  }
  return `${whole.slice(0, budget)}…(cut)`;
}

function trimNestedList(record: unknown, head: unknown[], truncated: boolean, budget: number): string | null {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const obj = record as Record<string, unknown>;
  // EVERY list of records in it — deal_file holds quotes, checklist, papers and signing at once (re-review of #1157).
  // A bare array of strings (tags, reasons) is a field, not records.
  const keys = Object.keys(obj).filter(
    (k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).length > 0 && (obj[k] as unknown[]).every((v) => v && typeof v === "object"),
  );
  if (!keys.length) return null;
  const full = Object.fromEntries(keys.map((k) => [k, (obj[k] as unknown[]).length]));
  const kept = { ...full };
  // ponytail: drops one record at a time from whichever list is longest now, so every list keeps its first records;
  // re-measures each step (lists here are ≤60 each).
  for (;;) {
    const cut = keys.filter((k) => kept[k] < full[k]);
    const body = JSON.stringify({
      truncated: true,
      showing: cut.map((k) => `${k} ${kept[k]} of ${full[k]}`).join(", ") + (truncated ? " (and the lookup had more)" : ""),
      note: `Only the first records of ${cut.join(", ")} fit (the totals with them are complete). Narrow the lookup to see the rest — never say these are all of them.`,
      results: [...head, { ...obj, ...Object.fromEntries(keys.map((k) => [k, (obj[k] as unknown[]).slice(0, kept[k])])) }],
    });
    if (cut.length && body.length <= budget) return body;
    const longest = keys.filter((k) => kept[k] > 0).sort((a, b) => kept[b] - kept[a])[0];
    if (!longest) return null; // every list emptied and it still doesn't fit: the documented cut
    kept[longest]--;
  }
}

/** A lookup that threw: which, what kind of failure, and what to do — not "that lookup failed". */
export function lookupFailedNote(tool: string, error: unknown): { note: string } {
  const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    note: timedOut
      ? `The ${tool} lookup timed out. Try it once more with narrower filters, or say it couldn't be checked just now.`
      : `The ${tool} lookup failed (an error on our side, logged). Don't retry it; answer from the other lookups and say what couldn't be checked.`,
  };
}
