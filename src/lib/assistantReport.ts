/**
 * A DAX answer as a report — the layout the PDF is drawn from.
 *
 * ── WHAT A REPORT IS ───────────────────────────────────────────────────────
 *
 * Nothing new is looked up to make one. A report is an answer DAX already gave
 * — the same facts, from the same lookups, under the same permissions of the
 * person who asked — set out as a document. That is the whole safety argument:
 * the PDF cannot hold a record the answer did not, and the answer could only
 * hold what that person may see.
 *
 * ── THE SHAPE DAX WRITES ───────────────────────────────────────────────────
 *
 * Answers are plain text (ANSWER_RULES forbids markdown, because the chat and
 * WhatsApp show it raw). So a report is written in a shape that still reads as
 * plain text and that this file can lay out (REPORT_RULE):
 *
 *   Report: Stuck deals, week of 9 November
 *   A two or three sentence summary.
 *
 *   Waiting on the customer:
 *   - Anna Mokoena — quote viewed, unsigned for 6 days
 *
 *   Columns: Customer | Value | Days quiet
 *   - Anna Mokoena | R 84 000 | 6
 *
 * Every rule here is forgiving. An ordinary answer — no title, no headings —
 * still lays out as tidy paragraphs and lists, so "PDF" works on any answer,
 * not only on ones DAX wrote as a report.
 *
 * Pure, so it is tested.
 */

export type ReportBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean }
  | { kind: "table"; columns: string[]; rows: string[][] }
  /** "My read:" — DAX's own judgement, kept visibly apart from the records. */
  | { kind: "read"; text: string }
  /** "Not in the CRM:" — something the question needed that the records don't hold. */
  | { kind: "missing"; text: string };

export type Report = { title: string; blocks: ReportBlock[] };

export const REPORT_TITLE_CHARS = 90;
/** A table wider than this cannot be read on an A4 page; it is drawn as a list instead. */
export const REPORT_MAX_COLUMNS = 6;

/**
 * Added to the answer rules. It changes how a report is WRITTEN, never what may
 * be said: every rule before it (facts only from the results, "My read:", "Not
 * in the CRM:", capped results said so) still holds.
 */
export const REPORT_RULE = [
  "REPORTS. When the person asks for a report, a PDF, a write-up or a document about something in the CRM, look up what it needs and write the answer as a report — still plain text, and every rule above still holds.",
  "First line: \"Report: <short title>\". Then a two- or three-sentence summary of what matters most. Then short sections, each starting with a heading on its own line that ends in a colon, with '-' lists or short paragraphs under it.",
  "A list of records with the same few details each may be a table: one line \"Columns: A | B | C\", then one '-' line per record with exactly that many parts separated by \" | \". At most six columns.",
  "End with one short line telling them to press PDF under this answer to download it with the business's name and logo (asked on WhatsApp or on a schedule: the PDF button is under this answer on their Ask page in the CRM).",
  "You do not create, attach or send the file yourself, and a report never goes to a customer from you. Pressing PDF under ANY of your answers downloads that answer as a document, so never refuse a PDF.",
].join(" ");

/** Did they ask for a document? Such a question is researched in depth, not answered in passing. */
export function wantsReport(question: string): boolean {
  return /\b(report|pdf|write[- ]?up|summary document|document (?:on|about|for)|brief(?:ing)? (?:on|about|for)|compile)\b/i.test(question);
}

// Evidence markers the answer step leaves for the chat's chips: [[3]] and [[/leads/…]].
const EVIDENCE = /\s*\[\[[^\]\n]*\]\]/g;
// The PDF's built-in fonts have no emoji; a missing glyph prints as a stray box.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

/** One line as the PDF can print it: no evidence markers, no emoji, no doubled spaces. */
export function printable(line: string): string {
  return line
    .replace(EVIDENCE, "")
    .replace(EMOJI, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .trim();
}

const BULLET = /^\s*(?:[-•*–]|(\d{1,2})[.)])\s+(.*)$/;
// The line that tells them where the PDF button is — said in the chat, pointless in the PDF itself.
const POINTER = /\bpress pdf\b|\bpdf button\b/i;
const COLUMNS = /^\s*columns\s*:\s*(.+)$/i;
const TITLE = /^\s*report\s*:\s*(.+)$/i;
const READ = /^\s*my read\s*:\s*(.*)$/i;
const MISSING = /^\s*not in the crm\s*:\s*(.*)$/i;

const cells = (text: string) => text.split("|").map((cell) => cell.trim());

/** A heading is a short line of its own that ends in a colon and is not a sentence. */
function isHeading(line: string): boolean {
  if (!line.endsWith(":") || line.length > 70) return false;
  const body = line.slice(0, -1);
  return body.length > 1 && !/[.!?]/.test(body) && body.split(/\s+/).length <= 9;
}

/** A title from the question, when the answer did not bring its own. */
export function titleFromQuestion(question: string): string {
  const cleaned = printable(question)
    .replace(/^(?:hi|hey|hello|please|can you|could you|would you|dax)[, ]+/i, "")
    .replace(/^(?:give me|send me|make me|create|compile|write|draw up|put together|generate|i need|i want)\s+(?:me\s+)?/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/\b(?:as a|in a|to a)?\s*pdf\b/gi, "")
    .replace(/[?.!\s]+$/, "")
    .trim();
  const title = cleaned || "Report";
  const capped = title.length > REPORT_TITLE_CHARS ? `${title.slice(0, REPORT_TITLE_CHARS - 1).trimEnd()}…` : title;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** The answer, laid out. Never throws and never returns an empty report. */
export function buildReport(question: string, answer: string): Report {
  const lines = answer.replace(/\r\n/g, "\n").split("\n").map(printable);
  const blocks: ReportBlock[] = [];
  let title = "";
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let table: { columns: string[]; rows: string[][] } | null = null;

  const closeParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  const closeList = () => {
    if (list.length) blocks.push({ kind: "list", items: list, ordered });
    list = [];
  };
  const closeTable = () => {
    if (!table) return;
    // Headers with no rows under them are a line of text, not a table.
    if (table.rows.length) blocks.push({ kind: "table", columns: table.columns, rows: table.rows });
    else blocks.push({ kind: "paragraph", text: table.columns.join(" · ") });
    table = null;
  };
  const closeAll = () => {
    closeParagraph();
    closeList();
    closeTable();
  };

  for (const line of lines) {
    if (!line) {
      closeAll();
      continue;
    }
    if (POINTER.test(line)) continue;
    const titled = !title && !blocks.length && !paragraph.length ? line.match(TITLE) : null;
    if (titled) {
      title = titled[1].slice(0, REPORT_TITLE_CHARS);
      continue;
    }
    const columns = line.match(COLUMNS);
    if (columns) {
      closeAll();
      const names = cells(columns[1]).filter(Boolean);
      if (names.length >= 2 && names.length <= REPORT_MAX_COLUMNS) table = { columns: names, rows: [] };
      else blocks.push({ kind: "paragraph", text: line });
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet) {
      closeParagraph();
      const numbered = bullet[1] !== undefined;
      const text = bullet[2].trim();
      if (table) {
        const row = cells(text);
        if (row.length === table.columns.length) {
          table.rows.push(row);
          continue;
        }
        // A row that does not fit ends the table; nothing is dropped or squeezed in.
        closeTable();
      }
      // Numbered steps keep their numbers; a change of kind starts a new list.
      if (list.length && ordered !== numbered) closeList();
      ordered = numbered;
      if (text) list.push(text);
      continue;
    }
    const read = line.match(READ);
    const missing = read ? null : line.match(MISSING);
    if (read || missing) {
      closeAll();
      const text = (read ?? missing)![1].trim();
      if (text) blocks.push({ kind: read ? "read" : "missing", text });
      continue;
    }
    if (isHeading(line)) {
      closeAll();
      blocks.push({ kind: "heading", text: line.slice(0, -1).trim() });
      continue;
    }
    closeList();
    closeTable();
    paragraph.push(line);
  }
  closeAll();

  if (!blocks.length) blocks.push({ kind: "paragraph", text: "There was nothing in this answer to put in a report." });
  return { title: title || titleFromQuestion(question), blocks };
}

/** A safe file name for the download: letters, digits and dashes only. */
export function reportFileName(title: string, company: string): string {
  const slug = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/[^\x20-\x7E]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  return `${[slug(company), slug(title) || "report"].filter(Boolean).join("-")}.pdf`;
}
