"use client";

import { create } from "zustand";
import type { DocumentModel, DocumentBlock, OverlayField, Recipient, DocStyle, LayoutSettings } from "./model";
import { newPage, newRecipient } from "./factory";
import type { LibrarySection } from "./librarySection";
import * as ops from "./ops";
import { getBlock } from "./ops";
import { findPlaced, groupMembers, movePlaced, nudgePlaced, placedRects, removePlaced } from "./arrange";

const HISTORY_LIMIT = 60;

/** Selecting one member of a group selects the group. */
const grouped = (doc: DocumentModel | undefined, id: string | null): string[] => {
  const members = doc && id ? groupMembers(doc, id) : [];
  return members.length >= 2 ? members : [];
};

export type LinkedRecord = { kind: "quote" | "jobcard"; id: string; label: string } | null;

type Selection = { blockId: string | null; fieldId: string | null };

interface EditorState {
  doc: DocumentModel;
  sel: Selection;
  activeTextBlockId: string | null; // only this rich-text block mounts a live Plate editor
  linked: LinkedRecord;
  past: DocumentModel[];
  future: DocumentModel[];
  dirty: boolean;

  // history-aware mutation
  commit: (producer: (doc: DocumentModel) => DocumentModel) => void;
  load: (doc: DocumentModel) => void;
  markSaved: () => void;
  undo: () => void;
  redo: () => void;

  // selection
  select: (blockId: string | null) => void;
  selectField: (fieldId: string | null) => void;
  setActiveText: (blockId: string | null) => void;
  /**
   * Several PLACED things selected at once (freely placed blocks by block id,
   * signing fields by id) — empty unless there are two or more. `sel` is still
   * the one last clicked. See ./arrange.ts.
   */
  picked: string[];
  /** Shift-click: add a placed thing to the selection, or take it out. Same page only. */
  togglePick: (id: string) => void;
  /** Put placed things at new positions, as one undo step. */
  arrange: (producer: (doc: DocumentModel) => DocumentModel) => void;
  /** Delete everything in the selection, as one undo step. */
  removePicked: () => void;
  /** A placed thing was dragged to (x, y): the rest of the selection follows by the same distance, as one undo step. */
  dragPlacedTo: (id: string, to: { x: number; y: number }) => void;

  // block ops
  dropRelative: (targetId: string, zone: ops.DropZone, incoming: DocumentBlock, moveId?: string) => void;
  appendToPage: (pageIdx: number, block: DocumentBlock) => void;
  updateBlock: (id: string, patch: Partial<DocumentBlock>, history?: boolean) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  toggleLock: (id: string) => void;
  toggleHide: (id: string) => void;
  moveToPage: (id: string, pageIdx: number) => void;
  setColumnWidths: (rowId: string, widths: number[]) => void;

  // free placement (floating content)
  detach: (id: string) => void;
  dock: (id: string) => void;
  updateFloating: (id: string, patch: { x?: number; y?: number; width?: number }) => void;
  insertLibrary: (section: LibrarySection) => void;

  // pages
  addPage: () => void;
  removePage: (pageId: string) => void;
  duplicatePage: (pageId: string) => void;
  movePage: (pageId: string, by: -1 | 1) => void;
  /** The page the person last clicked on — where a new signing field or library item goes. */
  activePage: number;
  setActivePage: (pageIdx: number) => void;
  /** A copied block style, waiting to be pasted onto another block. Not part of the document or its undo history. */
  styleClipboard: Partial<LayoutSettings> | null;
  copyStyle: (style: Partial<LayoutSettings>) => void;
  /** How many sheets each page prints on, measured by the editor page (only it can know) — read by the design check. */
  pageSheets: Record<string, number>;
  setPageSheets: (pageId: string, sheets: number) => void;

  // overlay fields
  addField: (pageIdx: number, field: OverlayField) => void;
  updateField: (id: string, patch: Partial<OverlayField>) => void;
  removeField: (id: string) => void;

  // recipients
  addRecipient: () => void;
  updateRecipient: (id: string, patch: Partial<Recipient>) => void;
  removeRecipient: (id: string) => void;

  // doc chrome
  setTitle: (title: string) => void;
  setStyle: (patch: Partial<DocStyle>) => void;
  setLinked: (linked: LinkedRecord) => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: undefined as unknown as DocumentModel, // set by load() on mount
  sel: { blockId: null, fieldId: null },
  activeTextBlockId: null,
  activePage: 0,
  styleClipboard: null,
  copyStyle: (style) => set({ styleClipboard: style }),
  pageSheets: {},
  setPageSheets: (pageId, sheets) => set((s) => (s.pageSheets[pageId] === sheets ? s : { pageSheets: { ...s.pageSheets, [pageId]: sheets } })),
  linked: null,
  past: [],
  future: [],
  dirty: false,

  commit: (producer) => set((s) => {
    if (!s.doc) return s;
    const next = producer(s.doc);
    if (next === s.doc) return s; // no-op ops return the same ref
    return { doc: next, past: [...s.past, s.doc].slice(-HISTORY_LIMIT), future: [], dirty: true };
  }),

  load: (doc) => set({ doc, past: [], future: [], dirty: false, sel: { blockId: null, fieldId: null }, activeTextBlockId: null, picked: [] }),
  markSaved: () => set({ dirty: false }),

  undo: () => set((s) => {
    if (s.past.length === 0) return s;
    const prev = s.past[s.past.length - 1];
    return { doc: prev, past: s.past.slice(0, -1), future: [s.doc, ...s.future].slice(0, HISTORY_LIMIT), dirty: true };
  }),
  redo: () => set((s) => {
    if (s.future.length === 0) return s;
    const nextDoc = s.future[0];
    return { doc: nextDoc, future: s.future.slice(1), past: [...s.past, s.doc].slice(-HISTORY_LIMIT), dirty: true };
  }),

  select: (blockId) => set((s) => {
    const block = blockId && s.doc ? getBlock(s.doc, blockId) : null;
    const isText = block?.type === "text" || block?.type === "heading";
    // Clicking something that is already part of the selection keeps the selection (so it can be dragged as one).
    if (blockId && s.picked.includes(blockId)) return { sel: { blockId, fieldId: null }, activeTextBlockId: null };
    return { sel: { blockId, fieldId: null }, activeTextBlockId: isText ? blockId : null, picked: grouped(s.doc, blockId) };
  }),
  selectField: (fieldId) => set((s) => (fieldId && s.picked.includes(fieldId)
    ? { sel: { blockId: null, fieldId }, activeTextBlockId: null }
    : { sel: { blockId: null, fieldId }, activeTextBlockId: null, picked: grouped(s.doc, fieldId) })),
  setActiveText: (blockId) => set({ activeTextBlockId: blockId }),

  picked: [],
  togglePick: (id) => set((s) => {
    const at = s.doc ? findPlaced(s.doc, id) : null;
    if (!at) return s;
    // Start from what is already selected — the selection, or the one thing clicked before this.
    const current = s.picked.length ? s.picked : [s.sel.blockId ?? s.sel.fieldId].filter((x): x is string => !!x && findPlaced(s.doc, x)?.pageIdx === at.pageIdx);
    const samePage = current.filter((x) => findPlaced(s.doc, x)?.pageIdx === at.pageIdx);
    const members = groupMembers(s.doc, id);
    const next = samePage.includes(id) ? samePage.filter((x) => !members.includes(x)) : [...new Set([...samePage, ...members])];
    const primary = next.includes(id) ? id : next[next.length - 1] ?? null;
    const kind = primary ? findPlaced(s.doc, primary)?.kind : null;
    return {
      picked: next.length >= 2 ? next : [],
      sel: { blockId: kind === "float" ? primary : null, fieldId: kind === "field" ? primary : null },
      activeTextBlockId: null,
    };
  }),
  arrange: (producer) => get().commit(producer),
  removePicked: () => { const ids = get().picked; get().commit((d) => removePlaced(d, ids)); set({ sel: { blockId: null, fieldId: null }, activeTextBlockId: null, picked: [] }); },
  dragPlacedTo: (id, to) => get().commit((d) => {
    const at = findPlaced(d, id);
    if (!at) return d;
    const page = d.pages[at.pageIdx];
    const from = placedRects(page, [id])[id];
    const followers = get().picked.filter((x) => x !== id);
    const moved = movePlaced(d, { [id]: to });
    return followers.length ? nudgePlaced(moved, followers, Math.max(0, to.x) - from.x, Math.max(0, to.y) - from.y) : moved;
  }),

  dropRelative: (targetId, zone, incoming, moveId) =>
    get().commit((d) => ops.insertRelative(d, targetId, zone, incoming, moveId)),
  appendToPage: (pageIdx, block) => get().commit((d) => ops.appendRow(d, pageIdx, block)),
  updateBlock: (id, patch, history = true) => {
    if (history) get().commit((d) => ops.updateBlock(d, id, patch));
    else set((s) => (s.doc ? { doc: ops.updateBlock(s.doc, id, patch), dirty: true } : s));
  },
  duplicate: (id) => get().commit((d) => ops.duplicateBlock(d, id)),
  remove: (id) => { get().commit((d) => ops.removeAnyBlock(d, id)); set({ sel: { blockId: null, fieldId: null }, activeTextBlockId: null, picked: [] }); },

  detach: (id) => { get().commit((d) => ops.detachBlock(d, id)); },
  dock: (id) => { get().commit((d) => ops.dockFloating(d, id)); },
  updateFloating: (id, patch) => get().commit((d) => ops.updateFloating(d, id, patch)),
  // Beside what the person has selected, or on the page they are working on —
  // not "the end of the last page", which is where it always used to land.
  insertLibrary: (section) => get().commit((d) => ops.insertSection(d, section, { afterBlockId: get().sel.blockId, pageIdx: get().activePage })),
  toggleLock: (id) => get().commit((d) => { const b = getBlock(d, id); return b ? ops.updateBlock(d, id, { locked: !b.locked } as Partial<DocumentBlock>) : d; }),
  toggleHide: (id) => get().commit((d) => { const b = getBlock(d, id); return b ? ops.updateBlock(d, id, { hidden: !b.hidden } as Partial<DocumentBlock>) : d; }),
  moveToPage: (id, pageIdx) => get().commit((d) => ops.moveBlockToPage(d, id, pageIdx)),
  setColumnWidths: (rowId, widths) => get().commit((d) => ops.setColumnWidths(d, rowId, widths)),

  addPage: () => get().commit((d) => ({ ...d, pages: [...d.pages, newPage()] })),
  removePage: (pageId) => { get().commit((d) => ops.removePage(d, pageId)); set((s) => ({ sel: { blockId: null, fieldId: null }, activeTextBlockId: null, picked: [], activePage: Math.min(s.activePage, Math.max(0, (s.doc?.pages.length ?? 1) - 1)) })); },
  duplicatePage: (pageId) => get().commit((d) => ops.duplicatePage(d, pageId)),
  movePage: (pageId, by) => get().commit((d) => ops.movePage(d, pageId, by)),
  setActivePage: (pageIdx) => set((s) => (s.activePage === pageIdx ? s : { activePage: pageIdx })),

  addField: (pageIdx, field) => get().commit((d) => {
    const pages = d.pages.map((p, i) => (i === pageIdx ? { ...p, overlayFields: [...p.overlayFields, field] } : p));
    return { ...d, pages };
  }),
  updateField: (id, patch) => get().commit((d) => ({
    ...d,
    pages: d.pages.map((p) => ({ ...p, overlayFields: p.overlayFields.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
  })),
  removeField: (id) => { get().commit((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, overlayFields: p.overlayFields.filter((f) => f.id !== id) })) })); set((s) => ({ sel: { ...s.sel, fieldId: null }, picked: [] })); },

  addRecipient: () => get().commit((d) => ({ ...d, recipients: [...d.recipients, newRecipient({ name: `Recipient ${d.recipients.length + 1}` })] })),
  updateRecipient: (id, patch) => get().commit((d) => ({ ...d, recipients: d.recipients.map((r) => (r.id === id ? { ...r, ...patch } : r)) })),
  removeRecipient: (id) => get().commit((d) => ({
    ...d,
    recipients: d.recipients.filter((r) => r.id !== id),
    pages: d.pages.map((p) => ({ ...p, overlayFields: p.overlayFields.map((f) => (f.recipientId === id ? { ...f, recipientId: null } : f)) })),
  })),

  setTitle: (title) => get().commit((d) => ({ ...d, title })),
  setStyle: (patch) => get().commit((d) => ({ ...d, style: { ...d.style, ...patch } })),
  setLinked: (linked) => set({ linked }),
}));
