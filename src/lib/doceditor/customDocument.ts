/**
 * Custom documents: a per-record copy of a "custom" document-editor template.
 *
 * Studio's rule, kept: merge data is resolved ONCE, when the document is made,
 * and frozen into the copy. What the person then edits is the text the customer
 * will read — a later change to the contact or the quote does not rewrite a
 * document someone has already prepared, and the template never changes it.
 *
 * Pure so the tests can run it; the actions in app/actions/customDocuments.ts
 * do the loading and the access checks.
 */
import type { DocumentModel } from "./model";

export type FrozenTokens = Record<string, string>;

/** The record snapshot a custom document renders with (a RenderCtx without `bound`). */
export type CustomDocSnapshot = {
  tokens: FrozenTokens;
  items: { cells: { value: string }[]; qty?: number; unitPrice?: number; discountPct?: number }[];
  vars: Record<string, unknown>;
};

/**
 * Studio's merge context and the quote's print context name some of the same
 * tokens from different places. Studio wins — it is what these templates were
 * written against — except where it has nothing and the quote does (a quote
 * linked without its contact still knows the customer's name).
 */
export function combineTokens(studio: FrozenTokens, record: FrozenTokens = {}): FrozenTokens {
  const out: FrozenTokens = { ...record, ...studio };
  for (const [key, value] of Object.entries(record)) if (value && !out[key]) out[key] = value;
  return out;
}

const TOKEN = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * Replace every KNOWN token in the document with its value: inline merge-field
 * nodes become plain text, and {{tokens}} typed into any string field (a
 * banner title, an info card, a table cell) are substituted. A token with an
 * empty value becomes empty text rather than staying a placeholder — the
 * renderer draws an unresolved field as a highlighted pill, which must not
 * appear on a finished document. Unknown tokens are left for the person to see.
 */
export function freezeDocumentTokens(doc: DocumentModel, tokens: FrozenTokens): DocumentModel {
  const known = (key: string) => Object.prototype.hasOwnProperty.call(tokens, key);
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(TOKEN, (whole, key: string) => (known(key) ? tokens[key] : whole));
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (node.type === "mergeField" && typeof node.token === "string" && known(node.token)) {
        return { text: tokens[node.token] };
      }
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, k === "id" ? v : walk(v)]));
    }
    return value;
  };
  return walk(doc) as DocumentModel;
}

/**
 * What a custom document renders with: its frozen record snapshot, or nothing
 * when it is linked to no record (so conditionals show as the layout, exactly
 * as an unbound template preview does).
 */
export function renderSnapshot(row: {
  contactId: string | null; leadId: string | null; quoteId: string | null; snapshotJson: unknown;
}): CustomDocSnapshot | null {
  const linked = Boolean(row.contactId || row.leadId || row.quoteId);
  return linked && row.snapshotJson ? (row.snapshotJson as CustomDocSnapshot) : null;
}

/** A finalised document is the record of what was sent; it is never edited again. */
export function customDocumentEditable(row: { status: string; docModelJson: unknown }): boolean {
  return row.status === "draft" && row.docModelJson != null;
}
