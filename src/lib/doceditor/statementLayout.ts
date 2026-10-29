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
 * footer, images, page furniture — is carried over untouched.
 *
 * Nothing to sign survives: a statement is not signed. Its signing fields and
 * recipients go, and so does every block a customer signs — the acceptance card
 * (name, signature and date lines, which print blank) and the handover checklist
 * (with its customer signature) — wherever the invoice has one: in a row, inside
 * a conditional, placed freely on the page, on a continuation page, in the
 * header or footer. What existed only to hold one goes with it: a conditional, a
 * row or an overflow group left with nothing else (review of #925).
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
      return { ...block, when: rewriteStatementTokens(block.when), blocks: statementBlocks(block.blocks) };
    default:
      return rewriteStrings(block);
  }
}

/** Blocks a customer signs. A statement is not signed, so none of them survives the conversion. */
const SIGNING_BLOCKS: ReadonlySet<DocumentBlock["type"]> = new Set(["acceptance", "handoverChecklist"]);

/**
 * A list of blocks as the statement wants it: each one converted, every signing
 * block dropped — inside conditionals too — and a conditional that held nothing
 * but signing blocks dropped with them. One the owner left empty stays as it was.
 */
export function statementBlocks(blocks: DocumentBlock[]): DocumentBlock[] {
  return blocks.flatMap((block): DocumentBlock[] => {
    if (SIGNING_BLOCKS.has(block.type)) return [];
    const converted = statementBlock(block);
    const emptied = block.type === "conditional" && converted.type === "conditional" && block.blocks.length > 0 && converted.blocks.length === 0;
    return emptied ? [] : [converted];
  });
}

/** The published invoice, converted into a statement's first layout. */
export function statementLayoutFromInvoice(invoice: DocumentModel): DocumentModel {
  /** Placed blocks, converted — a signing card, or a conditional left empty, taken off the page. */
  const floats = <T extends { block: DocumentBlock }>(list: T[]) =>
    list.flatMap((float) => statementBlocks([float.block]).map((block) => ({ ...float, block })));
  return {
    ...invoice,
    title: "Statement",
    // Nobody signs a statement.
    recipients: [],
    layoutRows: undefined,
    running: invoice.running ? rewriteStrings(invoice.running) : invoice.running,
    header: statementBlocks(invoice.header),
    footer: statementBlocks(invoice.footer),
    pages: invoice.pages.map((page) => {
      const floatingBlocks = floats(page.floatingBlocks);
      const kept = new Set(floatingBlocks.map((float) => float.id));
      const removed = new Set(page.floatingBlocks.filter((float) => !kept.has(float.id)).map((float) => float.id));
      return {
        ...page,
        overlayFields: [],
        // A row that held only something to sign goes with it rather than leave
        // its gap; a row the owner left empty stays.
        rows: page.rows.flatMap((row) => {
          const columns = row.columns.map((column) => ({ ...column, blocks: statementBlocks(column.blocks) }));
          const emptied = row.columns.some((column) => column.blocks.length > 0) && columns.every((column) => column.blocks.length === 0);
          return emptied ? [] : [{ ...row, columns }];
        }),
        floatingBlocks,
        // An overflow group moves its floats and fields to a continuation page.
        // The fields are gone, and so are the floats removed above; a group left
        // with nothing to move is dropped — kept, a long statement would still
        // get a continuation page carrying only the group's header and footer.
        overflowGroups: page.overflowGroups?.flatMap((group) => {
          const floatIds = group.floatIds.filter((id) => !removed.has(id));
          if ((group.floatIds.length > 0 || group.fieldIds.length > 0) && floatIds.length === 0) return [];
          return [{
            ...group,
            floatIds,
            fieldIds: [],
            nextPageFloats: group.nextPageFloats ? floats(group.nextPageFloats) : group.nextPageFloats,
          }];
        }),
      };
    }),
  };
}
