"use client";

import { create } from "zustand";
import type { DocumentModel, DocumentBlock, OverlayField, Recipient, DocStyle } from "./model";
import { newPage, newRecipient } from "./factory";
import * as ops from "./ops";
import { getBlock } from "./ops";

const HISTORY_LIMIT = 60;

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
  insertLibrary: (blocks: DocumentBlock[]) => void;

  // pages
  addPage: () => void;
  removePage: (pageId: string) => void;

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

  load: (doc) => set({ doc, past: [], future: [], dirty: false, sel: { blockId: null, fieldId: null }, activeTextBlockId: null }),
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
    return { sel: { blockId, fieldId: null }, activeTextBlockId: isText ? blockId : null };
  }),
  selectField: (fieldId) => set({ sel: { blockId: null, fieldId }, activeTextBlockId: null }),
  setActiveText: (blockId) => set({ activeTextBlockId: blockId }),

  dropRelative: (targetId, zone, incoming, moveId) =>
    get().commit((d) => ops.insertRelative(d, targetId, zone, incoming, moveId)),
  appendToPage: (pageIdx, block) => get().commit((d) => ops.appendRow(d, pageIdx, block)),
  updateBlock: (id, patch, history = true) => {
    if (history) get().commit((d) => ops.updateBlock(d, id, patch));
    else set((s) => (s.doc ? { doc: ops.updateBlock(s.doc, id, patch), dirty: true } : s));
  },
  duplicate: (id) => get().commit((d) => ops.duplicateBlock(d, id)),
  remove: (id) => { get().commit((d) => ops.removeAnyBlock(d, id)); set({ sel: { blockId: null, fieldId: null }, activeTextBlockId: null }); },

  detach: (id) => { get().commit((d) => ops.detachBlock(d, id)); },
  dock: (id) => { get().commit((d) => ops.dockFloating(d, id)); },
  updateFloating: (id, patch) => get().commit((d) => ops.updateFloating(d, id, patch)),
  insertLibrary: (blocks) => get().commit((d) => {
    let next = d;
    const pageIdx = Math.max(0, d.pages.length - 1);
    for (const b of blocks) next = ops.appendRow(next, pageIdx, ops.cloneWithNewIds(b));
    return next;
  }),
  toggleLock: (id) => get().commit((d) => { const b = getBlock(d, id); return b ? ops.updateBlock(d, id, { locked: !b.locked } as Partial<DocumentBlock>) : d; }),
  toggleHide: (id) => get().commit((d) => { const b = getBlock(d, id); return b ? ops.updateBlock(d, id, { hidden: !b.hidden } as Partial<DocumentBlock>) : d; }),
  moveToPage: (id, pageIdx) => get().commit((d) => ops.moveBlockToPage(d, id, pageIdx)),
  setColumnWidths: (rowId, widths) => get().commit((d) => ops.setColumnWidths(d, rowId, widths)),

  addPage: () => get().commit((d) => ({ ...d, pages: [...d.pages, newPage()] })),
  removePage: (pageId) => get().commit((d) => (d.pages.length <= 1 ? d : { ...d, pages: d.pages.filter((p) => p.id !== pageId) })),

  addField: (pageIdx, field) => get().commit((d) => {
    const pages = d.pages.map((p, i) => (i === pageIdx ? { ...p, overlayFields: [...p.overlayFields, field] } : p));
    return { ...d, pages };
  }),
  updateField: (id, patch) => get().commit((d) => ({
    ...d,
    pages: d.pages.map((p) => ({ ...p, overlayFields: p.overlayFields.map((f) => (f.id === id ? { ...f, ...patch } : f)) })),
  })),
  removeField: (id) => { get().commit((d) => ({ ...d, pages: d.pages.map((p) => ({ ...p, overlayFields: p.overlayFields.filter((f) => f.id !== id) })) })); set((s) => ({ sel: { ...s.sel, fieldId: null } })); },

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
