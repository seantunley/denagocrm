import type { DocumentModel, DocumentPage } from "./model";

/** Bound line-item rows in a render context — what the overflow groups are sized against. */
export function boundRowCount(ctx: { items?: unknown[]; bound?: boolean } | null | undefined): number {
  return ctx?.bound ? ctx.items?.length ?? 0 : 0;
}

/**
 * The row count a render lays the document out for: the one frozen into a
 * signing snapshot at send time when there is one, else the live record's.
 */
export function layoutRowsFor(doc: DocumentModel, ctx: { items?: unknown[]; bound?: boolean } | null | undefined): number {
  return doc.layoutRows ?? boundRowCount(ctx);
}

/**
 * Resolve every page's overflow groups (see overflowGroupSchema) for a document
 * with `itemCount` line-item rows. A group whose `maxItems` is exceeded leaves
 * the page — its floating blocks AND overlay fields together, so a signature
 * field stays on its line — and, unless it is a `drop` group, lands on a new
 * page inserted straight after (lifted to `topOnNextPage` when set), along with
 * the group's `nextPageFloats`. Groups that fit stay put.
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
    const leaving = (overflowGroups ?? []).filter((group) => itemCount > group.maxItems);
    if (!leaving.length) {
      pages.push(page);
      continue;
    }
    const next: DocumentPage = { id: `${page.id}-continued`, rows: [], overlayFields: [], floatingBlocks: [] };
    const gone = { floats: new Set<string>(), fields: new Set<string>() };
    for (const group of leaving) {
      const floats = page.floatingBlocks.filter((f) => group.floatIds.includes(f.id) && !gone.floats.has(f.id));
      const fields = page.overlayFields.filter((f) => group.fieldIds.includes(f.id) && !gone.fields.has(f.id));
      floats.forEach((f) => gone.floats.add(f.id));
      fields.forEach((f) => gone.fields.add(f.id));
      next.floatingBlocks.push(...(group.nextPageFloats ?? []));
      if (group.drop) continue;
      const top = Math.min(...floats.map((f) => f.y), ...fields.map((f) => f.anchor.y));
      const dy = group.topOnNextPage !== undefined && Number.isFinite(top) ? group.topOnNextPage - top : 0;
      next.floatingBlocks.push(...floats.map((f) => ({ ...f, y: f.y + dy })));
      next.overlayFields.push(...fields.map((f) => ({ ...f, anchor: { ...f.anchor, y: f.anchor.y + dy } })));
    }
    pages.push({
      ...page,
      floatingBlocks: page.floatingBlocks.filter((f) => !gone.floats.has(f.id)),
      overlayFields: page.overlayFields.filter((f) => !gone.fields.has(f.id)),
    });
    // A drop-only overflow (nothing to carry) adds no empty page.
    if (next.floatingBlocks.length || next.overlayFields.length) pages.push(next);
  }
  return { ...doc, pages };
}
