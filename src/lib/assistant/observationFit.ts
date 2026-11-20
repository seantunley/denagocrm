/**
 * What DAX's research step is shown when a lookup is too big or fails — Scarlet's tool rules, applied (docs/dax-tools-
 * and-learning-audit-2026-11-20.md, gaps 1 and 2): an answer ends at whole records and says how many it left out and
 * how to get them; a failure says which lookup, what kind of failure, and what to do instead. Pure.
 */

/**
 * The lookup's results as the model reads them, within `budget` characters. Over budget, whole records are dropped
 * from the end (the lookups put the most relevant first) and the model is told "showing N of M" — never JSON cut
 * mid-record with no way to know what was lost. A single record still too big is cut as before.
 */
export function fitObservation(results: unknown, truncated: boolean, budget: number): string {
  const whole = JSON.stringify({ truncated, results });
  if (whole.length <= budget || !Array.isArray(results) || results.length < 2) {
    return whole.length > budget ? `${whole.slice(0, budget)}…(cut)` : whole;
  }
  // ponytail: drops one record at a time and re-measures (lists cap at 60 rows, so ≤60 stringifies).
  for (let n = results.length - 1; n >= 1; n--) {
    const body = JSON.stringify({
      truncated: true,
      showing: `${n} of ${results.length}${truncated ? "+" : ""}`,
      note: `Only the first ${n} fit. Narrow the lookup (a stage, person, dates or a smaller limit) to see the rest — never say these are all of them.`,
      results: results.slice(0, n),
    });
    if (body.length <= budget) return body;
  }
  const one = JSON.stringify({ truncated: true, showing: `1 of ${results.length}`, results: results.slice(0, 1) });
  return `${one.slice(0, budget)}…(cut)`;
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
