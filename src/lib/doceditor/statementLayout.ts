/**
 * A STATEMENT LAYOUT MADE FROM THE WORKSPACE'S OWN INVOICE (Sean, 2026-10-28:
 * "look at the invoice template — why is the statement different? Not even
 * picking up the banking").
 *
 * The statement's first layout is the PUBLISHED invoice layout, converted — so
 * it has the invoice's header, colours, fonts, banking details, payment terms
 * and footer exactly as the owner set them, and is then edited and published on
 * its own in Settings → Documents. What changes:
 *
 *   header        title → STATEMENT; its number → the statement date
 *   info strip    → statement date · account · balance
 *   BILL TO card  → STATEMENT FOR, the account and its address lines
 *   line items    → the statement table (block "statementLines"), same look
 *   totals        → total invoiced, less deposits & payments, BALANCE DUE
 *   merge fields  {{invoice.number}} → {{statement.reference}} (the banking
 *                 "Reference:" line), {{invoice.date}} → {{statement.date}},
 *                 {{invoice.billedTo}} → {{statement.accountLines}},
 *                 {{quote.total}} → {{statement.balance}}; any other quote,
 *                 invoice or agreement field is dropped — a statement has no
 *                 single quote to read it from.
 *
 * Everything else — the banking card, payment terms, the thank-you line, the
 * footer, images, page furniture — is carried over untouched. Signing fields are
 * dropped: a statement is not signed.
 *
 * Pure: a document in, a document out. The caller saves it.
 */
import { uid } from "./factory";
import type { DocumentBlock, DocumentModel, StatementLinesBlock } from "./model";
import { DEFAULT_STATEMENT_COLUMNS } from "./model";

const TOKEN_REWRITES: [RegExp, string][] = [
  // The footer band's "Invoice {{invoice.number}}" reads as the statement's date.
  [/\bInvoice\s+\{\{\s*invoice\.number\s*\}\}/g, "Statement {{statement.date}}"],
  [/\{\{\s*invoice\.number\s*\}\}/g, "{{statement.reference}}"],
  [/\{\{\s*invoice\.date\s*\}\}/g, "{{statement.date}}"],
  [/\{\{\s*invoice\.billedTo\s*\}\}/g, "{{statement.accountLines}}"],
  [/\{\{\s*quote\.total\s*\}\}/g, "{{statement.balance}}"],
  // No single quote, invoice or agreement behind a statement.
  [/\{\{\s*(?:quote|invoice|agreement|lead)\.[\w.]+\s*\}\}/g, ""],
];

export function rewriteStatementTokens(text: string): string {
  return TOKEN_REWRITES.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

/** Every string in a value, rewritten — rich text, labels, lines, nested blocks. */
function rewriteStrings<T>(value: T): T {
  if (typeof value === "string") return rewriteStatementTokens(value) as T;
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStrings(item)])) as T;
  }
  return value;
}

const BILL_TO = /\{\{\s*(?:customer\.name|invoice\.billedTo)\s*\}\}/;

function statementTable(from: Extract<DocumentBlock, { type: "lineItems" | "pricing" }>): StatementLinesBlock {
  return {
    id: uid(),
    type: "statementLines",
    settings: from.settings,
    locked: from.locked,
    hidden: from.hidden,
    look: from.type === "lineItems" ? from.look : undefined,
    headerBg: from.type === "lineItems" ? from.headerBg : "#020617",
    headerColor: from.type === "lineItems" ? from.headerColor : "#ffffff",
    columns: DEFAULT_STATEMENT_COLUMNS.map((column) => ({ ...column })),
    tableStyle: from.tableStyle,
  };
}

/** One block, as the statement wants it. */
export function statementBlock(block: DocumentBlock): DocumentBlock {
  switch (block.type) {
    case "showcaseHeader":
      return {
        ...block,
        title: "STATEMENT",
        docNumber: "{{statement.date}}",
        ...(block.numberLabel !== undefined ? { numberLabel: "Statement date" } : {}),
        ...(block.subtitle !== undefined ? { subtitle: rewriteStatementTokens(block.subtitle) } : {}),
      };
    case "banner":
      return { ...block, title: "STATEMENT", docNumber: "{{statement.date}}" };
    case "infoStrip": {
      const icon = (i: number, fallback: (typeof block.items)[number]["icon"]) => block.items[i]?.icon ?? fallback;
      return {
        ...block,
        items: [
          { icon: icon(0, "calendar"), label: "STATEMENT DATE", value: "{{statement.date}}", sub: "" },
          { icon: icon(1, "user"), label: "ACCOUNT", value: "{{statement.accountName}}", sub: "" },
          { icon: icon(2, "calendarCheck"), label: "{{statement.balanceLabel}}", value: "{{statement.balance}}", sub: "" },
        ],
      };
    }
    case "infoCard":
      if (!BILL_TO.test(`${block.name}\n${block.lines}`)) return rewriteStrings(block);
      return { ...block, label: "STATEMENT FOR", name: "{{statement.accountName}}", lines: "{{statement.accountLines}}" };
    case "lineItems":
      return statementTable(block);
    case "pricing":
      // A pricing table filled from the quote is the invoice's lines; a typed one is the owner's own content.
      return block.bound ? statementTable(block) : rewriteStrings(block);
    case "totalsBox":
      return {
        ...block,
        rows: [
          { label: "Total invoiced", value: "{{statement.invoiced}}" },
          { label: "Less deposits & payments", value: "{{statement.paid}}" },
        ],
        totalLabel: "{{statement.balanceLabel}}",
        totalAmount: "{{statement.balance}}",
      };
    case "totalBand":
      return { ...block, label: "{{statement.balanceLabel}}", amount: "{{statement.balance}}" };
    case "conditional":
      return { ...block, when: rewriteStatementTokens(block.when), blocks: block.blocks.map(statementBlock) };
    default:
      return rewriteStrings(block);
  }
}

/** The published invoice, converted into a statement's first layout. */
export function statementLayoutFromInvoice(invoice: DocumentModel): DocumentModel {
  const floats = <T extends { block: DocumentBlock }>(list: T[]) => list.map((float) => ({ ...float, block: statementBlock(float.block) }));
  return {
    ...invoice,
    title: "Statement",
    // Nobody signs a statement.
    recipients: [],
    layoutRows: undefined,
    running: invoice.running ? rewriteStrings(invoice.running) : invoice.running,
    header: invoice.header.map(statementBlock),
    footer: invoice.footer.map(statementBlock),
    pages: invoice.pages.map((page) => ({
      ...page,
      overlayFields: [],
      rows: page.rows.map((row) => ({
        ...row,
        columns: row.columns.map((column) => ({ ...column, blocks: column.blocks.map(statementBlock) })),
      })),
      floatingBlocks: floats(page.floatingBlocks),
      overflowGroups: page.overflowGroups?.map((group) => ({
        ...group,
        fieldIds: [],
        nextPageFloats: group.nextPageFloats ? floats(group.nextPageFloats) : group.nextPageFloats,
      })),
    })),
  };
}
