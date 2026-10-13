/**
 * What an uploaded document IS: chosen from the workspace's list of document types.
 *
 * Sean, 2026-10-13: "Need to label an uploaded document. For example, I now have
 * the supplier quote, and my payment to them. When I upload, it's against
 * Q-1025, Supplier Quote, Proof of Payment Supplier etc." — and, of a box to type
 * the label into: "No, must have a drop down we can select".
 *
 * So it is a list. The workspace owner edits it in Settings → Quotes → Document
 * types; an upload picks one from it and the server accepts nothing else.
 *
 * The chosen type lives in Document.tag, beside the tags the CRM writes itself.
 * Those are lower-case slugs that code depends on ("pop" is what marks a deposit
 * as paid on the deliveries board; "signed", "delivery-note"…). So a type may be
 * any wording EXCEPT one of those slugs — on the list it would make a supplier's
 * paperwork count as the customer's — and a tag the CRM wrote is never replaced.
 */

export const DOCUMENT_TYPES_KEY = "DOCUMENT_TYPES";

/** The list a workspace starts with, until its owner changes it. */
export const DEFAULT_DOCUMENT_TYPES: readonly string[] = [
  "Supplier quote",
  "Supplier invoice",
  "Proof of payment — supplier",
  "Proof of payment — customer",
  "Customer invoice",
  "Purchase order",
  "ID document",
  "Proof of address",
  "Company registration",
  "Registration papers",
];

/** Tags the CRM writes and reads. Never a document type, and a document that has one cannot be relabelled. */
export const SYSTEM_DOCUMENT_TAGS: ReadonlySet<string> = new Set([
  "signed", "invoice", "pop", "delivery-note", "delivery-photo", "delivery-signature",
  "checkin", "checkin-photo", "checkout-photo", "generated-pdf", "for-signing",
]);

export const DOCUMENT_TYPE_MAX = 60;
export const DOCUMENT_TYPES_MAX = 40;

const tidy = (raw: string) => raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DOCUMENT_TYPE_MAX).trim();

/**
 * The saved setting (one type per line) → the list offered. Blank lines, repeats
 * (ignoring case) and the CRM's own tags are dropped; nothing left means the
 * workspace has not set a list, and gets the default one.
 */
export function parseDocumentTypes(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const types: string[] = [];
  for (const line of String(raw ?? "").split("\n")) {
    const type = tidy(line);
    const key = type.toLowerCase();
    if (!type || seen.has(key) || SYSTEM_DOCUMENT_TAGS.has(key)) continue;
    seen.add(key);
    types.push(type);
    if (types.length === DOCUMENT_TYPES_MAX) break;
  }
  return types.length ? types : [...DEFAULT_DOCUMENT_TYPES];
}

/** The type as it is on the list (exactly as listed), or null when what was posted is not one of them. "" is "no type". */
export function chosenDocumentType(posted: unknown, types: readonly string[]): { ok: true; type: string | null } | { ok: false } {
  const wanted = String(posted ?? "").trim();
  if (!wanted) return { ok: true, type: null };
  const type = types.find((candidate) => candidate === wanted);
  return type ? { ok: true, type } : { ok: false };
}

/** Whether a document's tag is a type a person chose (or none) — and so may be changed by a person. */
export const isPersonLabel = (tag: string | null | undefined): boolean => tag == null || !SYSTEM_DOCUMENT_TAGS.has(tag);
