import type { DocumentModel, DocumentPage } from "./model";

/** Bound line-item rows in a render context — what the overflow groups are sized against. */
export function boundRowCount(ctx: { items?: unknown[]; bound?: boolean } | null | undefined): number {
  return ctx?.bound ? ctx.items?.length ?? 0 : 0;
}

/**
 * Resolve every page's overflow groups (see overflowGroupSchema) for a document
 * with `itemCount` line-item rows: a group whose `maxItems` is exceeded moves —
 * its floating blocks AND overlay fields together, so a signature field stays on
 * its line — onto a new page inserted straight after, lifted to `topOnNextPage`
 * when set. Groups that fit stay put.
 *
 * The result carries no overflow groups, so it is idempotent and a document
 * resolved once (a signing snapshot, at send time) is static from then on: its
 * signature fields were created at those page coordinates and must not move
 * if the quote later gains a line. The new page's id is derived, not random,
 * so the same inputs give the same document.
 */
export function resolveOverflowGroups(doc: DocumentModel, itemCount: number): DocumentModel {
  if (!doc.pages.some((page) => page.overflowGroups)) return doc;
  const pages: DocumentPage[] = [];
  for (const { overflowGroups, ...page } of doc.pages) {
    const moving = (overflowGroups ?? []).filter((group) => itemCount > group.maxItems);
    if (!moving.length) {
      pages.push(page);
      continue;
    }
    const next: DocumentPage = { id: `${page.id}-continued`, rows: [], overlayFields: [], floatingBlocks: [] };
    const movedFloats = new Set<string>();
    const movedFields = new Set<string>();
    for (const group of moving) {
      const floats = page.floatingBlocks.filter((f) => group.floatIds.includes(f.id) && !movedFloats.has(f.id));
      const fields = page.overlayFields.filter((f) => group.fieldIds.includes(f.id) && !movedFields.has(f.id));
      const top = Math.min(...floats.map((f) => f.y), ...fields.map((f) => f.anchor.y));
      const dy = group.topOnNextPage !== undefined && Number.isFinite(top) ? group.topOnNextPage - top : 0;
      for (const f of floats) { movedFloats.add(f.id); next.floatingBlocks.push({ ...f, y: f.y + dy }); }
      for (const f of fields) { movedFields.add(f.id); next.overlayFields.push({ ...f, anchor: { ...f.anchor, y: f.anchor.y + dy } }); }
    }
    pages.push(
      {
        ...page,
        floatingBlocks: page.floatingBlocks.filter((f) => !movedFloats.has(f.id)),
        overlayFields: page.overlayFields.filter((f) => !movedFields.has(f.id)),
      },
      next,
    );
  }
  return { ...doc, pages };
}
