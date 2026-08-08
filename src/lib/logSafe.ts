/**
 * Make caller-supplied text safe to put in a log line.
 *
 * A log entry assembled from user input is forgeable: a message containing a
 * newline becomes two entries, and the second one can be made to look exactly
 * like a genuine line from anywhere else in the system. That turns an error
 * report into a way to write whatever you like into the record support reads
 * during an incident.
 *
 * Kept here, with no imports, so it is a plain module a test can execute. The
 * route that uses it pulls in `server-only` transitively through the auth
 * helpers, and a rule that can only be checked by matching source text is a rule
 * that drifts.
 */

/**
 * Collapse to a single line, drop control characters, and cap the length.
 *
 * Written as code-point comparisons rather than a regex character class: the
 * class would have to CONTAIN control characters, and a literal control byte in
 * source does not reliably survive being copied between tools.
 */
export function oneLine(value: string, max: number): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // CR, LF and TAB become a space so the entry stays on one line and words do
    // not run together.
    if (code === 13 || code === 10 || code === 9) {
      out += " ";
      continue;
    }
    // The rest of C0, plus DEL. These are what would forge a second entry or
    // rewrite the line in a terminal.
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.slice(0, max);
}
