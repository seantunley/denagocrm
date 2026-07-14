/**
 * Pure tree operations on the document model. Every function takes a document and
 * returns a NEW document (structural clone) — no mutation of the input — so the
 * Zustand store can snapshot for undo/redo trivially.
 *
 * The 5-zone drop is the core PandaDoc-style interaction:
 *
 *            ABOVE  (new row before target)
 *   LEFT   CENTRE   RIGHT   (split target row into columns / append in place)
 *            BELOW  (new row after target)
 */
import type { DocumentModel, DocumentBlock, DocumentRow } from "./model";
import { newColumn, newRow, uid } from "./factory";

export type DropZone = "above" | "below" | "left" | "right" | "centre";

function clone<T>(v: T): T {
  return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
}

export type BlockLoc = { pageIdx: number; rowIdx: number; colIdx: number; blockIdx: number };

/** Locate a top-level block (inside a page → row → column) by id. */
export function findBlockLoc(doc: DocumentModel, blockId: string): BlockLoc | null {
  for (let p = 0; p < doc.pages.length; p++) {
    const rows = doc.pages[p].rows;
    for (let r = 0; r < rows.length; r++) {
      const cols = rows[r].columns;
      for (let c = 0; c < cols.length; c++) {
        const bi = cols[c].blocks.findIndex((b) => b.id === blockId);
        if (bi >= 0) return { pageIdx: p, rowIdx: r, colIdx: c, blockIdx: bi };
      }
    }
  }
  return null;
}

/** Return a block by id (searches flow, floating, header/footer + nested conditional blocks). */
export function getBlock(doc: DocumentModel, blockId: string): DocumentBlock | null {
  const walk = (blocks: DocumentBlock[]): DocumentBlock | null => {
    for (const b of blocks) {
      if (b.id === blockId) return b;
      if (b.type === "conditional") {
        const found = walk(b.blocks);
        if (found) return found;
      }
    }
    return null;
  };
  for (const page of doc.pages) {
    for (const row of page.rows) for (const col of row.columns) {
      const f = walk(col.blocks);
      if (f) return f;
    }
    const ff = walk(page.floatingBlocks.map((fb) => fb.block));
    if (ff) return ff;
  }
  for (const f of [walk(doc.header), walk(doc.footer)]) if (f) return f;
  return null;
}

/** Rebalance a row's columns to equal widths summing to 100. */
function rebalance(row: DocumentRow): void {
  const n = row.columns.length;
  if (n === 0) return;
  const each = Math.round((100 / n) * 100) / 100;
  row.columns.forEach((c, i) => { c.widthPercent = i === n - 1 ? Math.round((100 - each * (n - 1)) * 100) / 100 : each; });
}

/** Drop empty columns and empty rows left behind after a move. */
function prune(doc: DocumentModel): void {
  for (const page of doc.pages) {
    for (const row of page.rows) {
      row.columns = row.columns.filter((c) => c.blocks.length > 0);
      if (row.columns.length > 0) rebalance(row);
    }
    page.rows = page.rows.filter((r) => r.columns.length > 0);
  }
}

/** Remove a top-level block by id (returns the removed block or null). */
function extractBlock(doc: DocumentModel, blockId: string): DocumentBlock | null {
  const loc = findBlockLoc(doc, blockId);
  if (!loc) return null;
  const col = doc.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx];
  const [removed] = col.blocks.splice(loc.blockIdx, 1);
  return removed;
}

/**
 * Insert `incoming` relative to `targetBlockId` using the given zone.
 * If `moveBlockId` is provided, that existing block is removed first (a move).
 */
export function insertRelative(
  doc: DocumentModel,
  targetBlockId: string,
  zone: DropZone,
  incoming: DocumentBlock,
  moveBlockId?: string,
): DocumentModel {
  const next = clone(doc);
  const block = clone(incoming);

  // For a move, remove the source first so target indices stay valid.
  if (moveBlockId) {
    if (moveBlockId === targetBlockId) return doc; // no-op onto self
    extractBlock(next, moveBlockId);
  }

  const loc = findBlockLoc(next, targetBlockId);
  if (!loc) { prune(next); return appendRow(next, 0, block); }
  const page = next.pages[loc.pageIdx];
  const row = page.rows[loc.rowIdx];

  if (zone === "above" || zone === "below") {
    const at = zone === "above" ? loc.rowIdx : loc.rowIdx + 1;
    page.rows.splice(at, 0, newRow([newColumn(100, [block])]));
  } else if (zone === "left" || zone === "right") {
    const at = zone === "left" ? loc.colIdx : loc.colIdx + 1;
    row.columns.splice(at, 0, newColumn(0, [block]));
    rebalance(row);
  } else { // centre — append into the target's column right after the target
    const col = row.columns[loc.colIdx];
    col.blocks.splice(loc.blockIdx + 1, 0, block);
  }
  prune(next);
  return next;
}

/** Append a block as a new full-width row at the end of a page. */
export function appendRow(doc: DocumentModel, pageIdx: number, incoming: DocumentBlock): DocumentModel {
  const next = clone(doc);
  const page = next.pages[Math.max(0, Math.min(pageIdx, next.pages.length - 1))];
  page.rows.push(newRow([newColumn(100, [clone(incoming)])]));
  return next;
}

/** Move an existing block to the end of a page (used by "move to page"). */
export function moveBlockToPage(doc: DocumentModel, blockId: string, pageIdx: number): DocumentModel {
  const next = clone(doc);
  const removed = extractBlock(next, blockId);
  if (!removed) return doc;
  prune(next);
  const page = next.pages[Math.max(0, Math.min(pageIdx, next.pages.length - 1))];
  page.rows.push(newRow([newColumn(100, [removed])]));
  return next;
}

/** Set explicit column widths for a row (used by the resize divider / properties). */
export function setColumnWidths(doc: DocumentModel, rowId: string, widths: number[]): DocumentModel {
  const next = clone(doc);
  for (const page of next.pages) {
    const row = page.rows.find((r) => r.id === rowId);
    if (row && row.columns.length === widths.length) {
      const total = widths.reduce((a, b) => a + b, 0) || 1;
      row.columns.forEach((c, i) => { c.widthPercent = Math.round((widths[i] / total) * 10000) / 100; });
      return next;
    }
  }
  return doc;
}

/** Shallow-merge a patch into a block (found anywhere, incl. nested). */
export function updateBlock(doc: DocumentModel, blockId: string, patch: Partial<DocumentBlock>): DocumentModel {
  const next = clone(doc);
  const target = getBlock(next, blockId);
  if (!target) return doc;
  Object.assign(target, patch);
  return next;
}

export function duplicateBlock(doc: DocumentModel, blockId: string): DocumentModel {
  const next = clone(doc);
  const loc = findBlockLoc(next, blockId);
  if (!loc) return doc;
  const col = next.pages[loc.pageIdx].rows[loc.rowIdx].columns[loc.colIdx];
  const copy = reid(clone(col.blocks[loc.blockIdx]));
  col.blocks.splice(loc.blockIdx + 1, 0, copy);
  return next;
}

export function deleteBlock(doc: DocumentModel, blockId: string): DocumentModel {
  const next = clone(doc);
  if (!extractBlock(next, blockId)) return doc;
  prune(next); // pages are preserved even if they end up with zero rows
  return next;
}

// ── free-placement (floating) content ───────────────────────────────

/** Lift a flow block out of its column and place it as a floating block on its page. */
export function detachBlock(doc: DocumentModel, blockId: string, at?: { x: number; y: number }): DocumentModel {
  const next = clone(doc);
  const loc = findBlockLoc(next, blockId);
  if (!loc) return doc;
  const pageIdx = loc.pageIdx;
  const removed = extractBlock(next, blockId);
  if (!removed) return doc;
  prune(next);
  next.pages[pageIdx].floatingBlocks.push({ id: uid(), x: at?.x ?? 64, y: at?.y ?? 80, width: 320, block: removed });
  return next;
}

/** Return a floating block into the normal flow (appended as a new row on its page). */
export function dockFloating(doc: DocumentModel, blockId: string): DocumentModel {
  const next = clone(doc);
  for (const page of next.pages) {
    const idx = page.floatingBlocks.findIndex((fb) => fb.block.id === blockId);
    if (idx >= 0) {
      const [fb] = page.floatingBlocks.splice(idx, 1);
      page.rows.push(newRow([newColumn(100, [fb.block])]));
      return next;
    }
  }
  return doc;
}

/** Update a floating block's position/size (found by its inner block id). */
export function updateFloating(doc: DocumentModel, blockId: string, patch: { x?: number; y?: number; width?: number }): DocumentModel {
  const next = clone(doc);
  for (const page of next.pages) {
    const fb = page.floatingBlocks.find((f) => f.block.id === blockId);
    if (fb) { Object.assign(fb, patch); return next; }
  }
  return doc;
}

/** True if the block id is a floating block. */
export function isFloating(doc: DocumentModel, blockId: string): boolean {
  return doc.pages.some((p) => p.floatingBlocks.some((fb) => fb.block.id === blockId));
}

/** Remove any block by id — flow or floating. */
export function removeAnyBlock(doc: DocumentModel, blockId: string): DocumentModel {
  if (isFloating(doc, blockId)) {
    const next = clone(doc);
    for (const page of next.pages) page.floatingBlocks = page.floatingBlocks.filter((fb) => fb.block.id !== blockId);
    return next;
  }
  return deleteBlock(doc, blockId);
}

/** Fresh ids for a duplicated block subtree. */
function reid(block: DocumentBlock): DocumentBlock {
  block.id = uid();
  if (block.type === "conditional") block.blocks = block.blocks.map(reid);
  return block;
}

/** Deep-clone a block with fresh ids (for inserting library items). */
export function cloneWithNewIds(block: DocumentBlock): DocumentBlock {
  return reid(clone(block));
}
