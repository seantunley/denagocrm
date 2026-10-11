/**
 * Arranging the things PLACED on a page — freely placed blocks and signing
 * fields — several at a time: line them up, space them evenly, keep them
 * together as a group, move them as one.
 *
 * Pure: positions in, positions out. A placed thing is named by one id — a
 * signing field's own id, or a freely placed block's BLOCK id (the id the
 * editor's selection already uses for it).
 */
import type { DocumentModel, DocumentPage } from "./model";
import { pageMargin, pageSizeOf } from "./model";
import { updateFloating } from "./ops";

export type Rect = { x: number; y: number; w: number; h: number };
export type AlignMode = "left" | "centre" | "right" | "top" | "middle" | "bottom";
export type Position = { x: number; y: number };

/** The page holding a placed thing, and what kind of thing it is. */
export function findPlaced(doc: DocumentModel, id: string): { pageIdx: number; kind: "float" | "field" } | null {
  for (let pageIdx = 0; pageIdx < doc.pages.length; pageIdx++) {
    const page = doc.pages[pageIdx];
    if (page.floatingBlocks.some((fb) => fb.block.id === id)) return { pageIdx, kind: "float" };
    if (page.overlayFields.some((f) => f.id === id)) return { pageIdx, kind: "field" };
  }
  return null;
}

/**
 * What is known about each thing's box from the document alone. A freely
 * placed block's HEIGHT is not in the document — its content decides it — so
 * the caller supplies the heights it measured on the page (`heights`, by id).
 */
export function placedRects(page: DocumentPage, ids: string[], heights: Record<string, number> = {}): Record<string, Rect> {
  const rects: Record<string, Rect> = {};
  for (const fb of page.floatingBlocks) if (ids.includes(fb.block.id)) rects[fb.block.id] = { x: fb.x, y: fb.y, w: fb.width, h: heights[fb.block.id] ?? 0 };
  for (const f of page.overlayFields) if (ids.includes(f.id)) rects[f.id] = { x: f.anchor.x, y: f.anchor.y, w: f.width, h: f.height };
  return rects;
}

const bounds = (rects: Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Line things up. Several things line up with each other (the box round them
 * all); ONE thing lines up with `within` — the sheet — because lining a thing
 * up with itself does nothing.
 */
export function alignRects(rects: Record<string, Rect>, mode: AlignMode, within?: Rect): Record<string, Position> {
  const ids = Object.keys(rects);
  if (ids.length === 0) return {};
  const frame = ids.length === 1 && within ? within : bounds(Object.values(rects));
  const out: Record<string, Position> = {};
  for (const id of ids) {
    const r = rects[id];
    out[id] = {
      x: round(mode === "left" ? frame.x : mode === "centre" ? frame.x + (frame.w - r.w) / 2 : mode === "right" ? frame.x + frame.w - r.w : r.x),
      y: round(mode === "top" ? frame.y : mode === "middle" ? frame.y + (frame.h - r.h) / 2 : mode === "bottom" ? frame.y + frame.h - r.h : r.y),
    };
  }
  return out;
}

/** Equal gaps between three or more things, across or down. The two outermost stay where they are. */
export function distributeRects(rects: Record<string, Rect>, axis: "across" | "down"): Record<string, Position> {
  const [pos, size] = axis === "across" ? (["x", "w"] as const) : (["y", "h"] as const);
  const ids = Object.keys(rects).sort((a, b) => rects[a][pos] - rects[b][pos]);
  if (ids.length < 3) return {};
  const first = rects[ids[0]], last = rects[ids[ids.length - 1]];
  const free = last[pos] + last[size] - first[pos] - ids.reduce((sum, id) => sum + rects[id][size], 0);
  const gap = free / (ids.length - 1);
  const out: Record<string, Position> = {};
  let at = first[pos];
  for (const id of ids) {
    out[id] = { x: rects[id].x, y: rects[id].y, [pos]: round(at) } as Position;
    at += rects[id][size] + gap;
  }
  return out;
}

/**
 * Put placed things at new positions, in one step. Never off the top or left
 * of the sheet. An acceptance card still takes the signature and date on its
 * lines with it (ops.updateFloating) — unless that field was itself given a
 * position here, which then wins.
 */
export function movePlaced(doc: DocumentModel, positions: Record<string, Position>): DocumentModel {
  let next = doc;
  const clamp = (p: Position) => ({ x: Math.max(0, p.x), y: Math.max(0, p.y) });
  for (const [id, to] of Object.entries(positions)) if (findPlaced(doc, id)?.kind === "float") next = updateFloating(next, id, clamp(to));
  const fields = Object.entries(positions).filter(([id]) => findPlaced(doc, id)?.kind === "field");
  if (fields.length === 0) return next;
  return {
    ...next,
    pages: next.pages.map((page) => ({
      ...page,
      overlayFields: page.overlayFields.map((f) => {
        const to = fields.find(([id]) => id === f.id)?.[1];
        return to ? { ...f, anchor: { ...f.anchor, ...clamp(to) } } : f;
      }),
    })),
  };
}

/** Move placed things by the same distance — a nudge, or the rest of a selection following the one that was dragged. */
export function nudgePlaced(doc: DocumentModel, ids: string[], dx: number, dy: number): DocumentModel {
  if ((!dx && !dy) || ids.length === 0) return doc;
  const positions: Record<string, Position> = {};
  for (const page of doc.pages) for (const [id, r] of Object.entries(placedRects(page, ids))) positions[id] = { x: r.x + dx, y: r.y + dy };
  return movePlaced(doc, positions);
}

/** Give several freely placed blocks the width of the widest. */
export function matchWidths(doc: DocumentModel, ids: string[]): DocumentModel {
  const floats = doc.pages.flatMap((p) => p.floatingBlocks).filter((fb) => ids.includes(fb.block.id));
  const fields = doc.pages.flatMap((p) => p.overlayFields).filter((f) => ids.includes(f.id));
  if (floats.length + fields.length < 2) return doc;
  const width = Math.max(...floats.map((fb) => fb.width), ...fields.map((f) => f.width));
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      floatingBlocks: page.floatingBlocks.map((fb) => (ids.includes(fb.block.id) ? { ...fb, width } : fb)),
      overlayFields: page.overlayFields.map((f) => (ids.includes(f.id) ? { ...f, width } : f)),
    })),
  };
}

// ── groups ──────────────────────────────────────────────────────────

/** Everything grouped with this thing (itself included), or just itself. */
export function groupMembers(doc: DocumentModel, id: string): string[] {
  const at = findPlaced(doc, id);
  if (!at) return [];
  const page = doc.pages[at.pageIdx];
  const groupId = page.floatingBlocks.find((fb) => fb.block.id === id)?.groupId ?? page.overlayFields.find((f) => f.id === id)?.groupId;
  if (!groupId) return [id];
  return [...page.floatingBlocks.filter((fb) => fb.groupId === groupId).map((fb) => fb.block.id), ...page.overlayFields.filter((f) => f.groupId === groupId).map((f) => f.id)];
}

/** Group these things (`groupId` given) or take them out of their group (null). A group of one is no group. */
export function setGroup(doc: DocumentModel, ids: string[], groupId: string | null): DocumentModel {
  if (groupId && ids.length < 2) return doc;
  const mark = <T extends { groupId?: string }>(item: T, member: boolean): T => {
    if (!member) return item;
    const { groupId: _old, ...rest } = item;
    void _old;
    return (groupId ? { ...rest, groupId } : rest) as T;
  };
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      floatingBlocks: page.floatingBlocks.map((fb) => mark(fb, ids.includes(fb.block.id))),
      overlayFields: page.overlayFields.map((f) => mark(f, ids.includes(f.id))),
    })),
  };
}

/** Remove placed things — blocks and fields alike — in one step. */
export function removePlaced(doc: DocumentModel, ids: string[]): DocumentModel {
  if (ids.length === 0) return doc;
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      floatingBlocks: page.floatingBlocks.filter((fb) => !ids.includes(fb.block.id)),
      overlayFields: page.overlayFields.filter((f) => !ids.includes(f.id)),
    })),
  };
}

/** A page inside its margins, as a box to line a single thing up within (the whole sheet when the margin is 0). */
export function pageBox(doc: DocumentModel, page: DocumentPage = doc.pages[0]): Rect {
  const size = pageSizeOf(doc.style);
  const m = pageMargin(doc, page);
  return { x: m, y: m, w: size.w - m * 2, h: size.h - m * 2 };
}
