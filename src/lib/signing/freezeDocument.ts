import type { DocumentModel } from "@/lib/doceditor/model";

function replaceStrings(value: unknown, tokens: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : whole,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStrings(item, tokens));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceStrings(item, tokens),
      ]),
    );
  }
  return value;
}

/**
 * Resolve record-independent values before a signature request is persisted. The
 * frozen snapshot therefore keeps the exact company identity and send date even
 * when settings change before later recipients sign.
 */
export function freezeDocumentGlobals(
  doc: DocumentModel,
  tokens: Record<string, string>,
): DocumentModel {
  return replaceStrings(doc, tokens) as DocumentModel;
}
