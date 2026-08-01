/**
 * The single CSV-writing boundary for every export in the app.
 *
 * Two jobs, both of which have to happen in the right order:
 *
 * 1. FORMULA NEUTRALISATION. Excel, LibreOffice and Google Sheets treat a cell
 *    whose first character is `=`, `+`, `-`, `@`, TAB or CR as a formula. Audit
 *    summaries, lead names and the `?name=` conversion label are all
 *    attacker-supplied text, so `=cmd|' /C calc'!A0` stored in a record becomes
 *    code execution on the reviewer's machine the moment they open the export —
 *    the export is the exploit, no CRM bug required. We prefix such a cell with
 *    an apostrophe (the OWASP mitigation), which every spreadsheet reads as
 *    "this is a text label".
 *
 * 2. QUOTING. Every cell is wrapped in double quotes with internal quotes
 *    doubled (RFC 4180), so embedded commas, quotes and newlines survive.
 *
 * The apostrophe goes on BEFORE the quoting, so it ends up inside the quoted
 * field rather than outside it where it would corrupt the record.
 */

/** Characters that make a spreadsheet evaluate the cell instead of showing it. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * A plain number, which must NOT be escaped: monetary columns are full of values
 * like `-1499.00`, and prefixing those with an apostrophe would turn every
 * negative amount into text and break the reviewer's SUM. Anchored end-to-end,
 * so a payload that merely opens like a number (`-2+3+cmd|'…'!A0`) fails the
 * test and is escaped.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/** Coerce any exported value to the text that belongs in the cell. */
function toText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value) ?? "";
}

/**
 * Render one value as a complete, safe CSV field — quotes included.
 *
 * Callers join the result with "," and rows with "\n"/"\r\n"; they must not add
 * quoting of their own.
 */
export function csvCell(value: unknown): string {
  const text = toText(value);
  const safe = FORMULA_LEAD.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Join one record's values into a CSV line. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(",");
}
