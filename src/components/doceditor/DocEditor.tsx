"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentModel } from "@/lib/doceditor/model";
import { saveDocEditor, sendDocForSigning } from "@/app/actions/doceditor";
import { DndController } from "./DndController";
import { Palette } from "./Palette";
import { Canvas } from "./Canvas";
import { PropertiesPanel } from "./PropertiesPanel";
import { VersionHistory } from "./VersionHistory";

type RecordOpt = { id: string; label: string };

export function DocEditor({ id, initialDoc, quotes }: { id: string; initialDoc: DocumentModel; quotes: RecordOpt[] }) {
  const load = useEditor((s) => s.load);
  const doc = useEditor((s) => s.doc);
  const dirty = useEditor((s) => s.dirty);
  const markSaved = useEditor((s) => s.markSaved);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const remove = useEditor((s) => s.remove);
  const removeField = useEditor((s) => s.removeField);
  const addPage = useEditor((s) => s.addPage);

  const [zoom, setZoom] = useState(0.9);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [quoteId, setQuoteId] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());

  // initial load
  useEffect(() => { load(initialDoc); }, [load, initialDoc]);

  // debounced autosave
  useEffect(() => {
    if (!doc || !dirty) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = doc; // exact content this save persists (commit() makes a new ref on every edit)
    saveTimer.current = setTimeout(() => {
      // Chain saves so they never run out of order or clobber a newer write.
      saveChain.current = saveChain.current.then(async () => {
        try {
          setSaveState("saving");
          const res = await saveDocEditor(id, snapshot);
          // Only clear "dirty" if no newer edit landed while this save was in flight.
          if (res.ok && useEditor.getState().doc === snapshot) { markSaved(); setSaveState("saved"); }
          else if (!res.ok) setSaveState("idle");
        } catch { setSaveState("idle"); }
      });
    }, 1200);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [doc, dirty, id, markSaved]);

  // keyboard shortcuts (ignore when typing in an editable element)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const editable = t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (!editable && (e.key === "Delete" || e.key === "Backspace")) {
        const { sel } = useEditor.getState();
        if (sel.blockId) { e.preventDefault(); remove(sel.blockId); }
        else if (sel.fieldId) { e.preventDefault(); removeField(sel.fieldId); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, remove, removeField]);

  const manualSave = async () => {
    if (!doc) return;
    setSaveState("saving");
    const res = await saveDocEditor(id, doc);
    if (res.ok) { markSaved(); setSaveState("saved"); }
  };

  if (!doc) return <div className="grid h-screen place-items-center text-slate-400">Loading editor…</div>;

  const previewUrl = `/api/pdf/doc-editor/${id}${quoteId ? `?quote=${quoteId}` : ""}`;
  const btn = "inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 px-2.5 text-sm text-slate-700 hover:bg-slate-50";

  return (
    <div className="flex h-screen flex-col bg-slate-100 text-slate-900">
      {/* top bar */}
      <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3">
        <Link href="/settings/documents/builder" className="text-sm text-slate-400 hover:text-slate-600">← Documents</Link>
        <input
          className="ml-1 w-56 rounded px-2 py-1 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none"
          value={doc.title} onChange={(e) => useEditor.getState().setTitle(e.target.value)}
        />
        <div className="mx-1 h-5 w-px bg-slate-200" />
        <button type="button" className={btn} onClick={undo} title="Undo (Ctrl+Z)">↶</button>
        <button type="button" className={btn} onClick={redo} title="Redo (Ctrl+Shift+Z)">↷</button>
        <button type="button" className={btn} onClick={() => addPage()} title="Add a page">＋ Page</button>
        <VersionHistory id={id} save={async () => { const d = useEditor.getState().doc; if (d) { await saveDocEditor(id, d); markSaved(); } }} />

        <div className="ml-auto flex items-center gap-2">
          <select className="h-8 rounded-md border border-slate-300 px-2 text-sm text-slate-700" value={quoteId} onChange={(e) => setQuoteId(e.target.value)} title="Preview with a real record">
            <option value="">Sample data</option>
            {quotes.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
          </select>
          <a className={btn} href={previewUrl} target="_blank" rel="noreferrer">Preview PDF ↗</a>
          <button
            type="button" className={btn}
            onClick={async () => {
              const d = useEditor.getState().doc; if (!d) return;
              await saveDocEditor(id, d); markSaved();
              const r = await sendDocForSigning(id, quoteId || null);
              alert(r.ok ? `✓ ${r.message}` : `Couldn’t prepare for signing: ${r.message}`);
            }}
            title="Seal + file the PDF and prepare recipients for signing"
          >✍ Send for signing</button>
          <details className="relative">
            <summary className={`${btn} cursor-pointer list-none`}>Export ▾</summary>
            <div className="absolute right-0 z-30 mt-1 w-44 rounded-md border border-slate-200 bg-white p-1 text-sm shadow-lg">
              {[["html", "Static HTML"], ["email", "Email-safe HTML"], ["doc", "Word (.doc)"]].map(([f, label]) => (
                <a key={f} className="block rounded px-2 py-1.5 text-slate-700 hover:bg-slate-50" href={`/api/doc-editor/${id}/export?format=${f}${quoteId ? `&quote=${quoteId}` : ""}`}>{label}</a>
              ))}
            </div>
          </details>
          <button type="button" className="inline-flex h-8 items-center rounded-md bg-orange-600 px-3 text-sm font-medium text-white hover:bg-orange-700" onClick={manualSave}>
            {saveState === "saving" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* body */}
      <DndController>
        <div className="flex min-h-0 flex-1">
          <aside className="w-60 flex-shrink-0 border-r border-slate-200 bg-slate-50">
            <Palette />
          </aside>
          <main className="min-w-0 flex-1 overflow-auto">
            <Canvas zoom={zoom} />
          </main>
          <aside className="w-80 flex-shrink-0 border-l border-slate-200 bg-white">
            <PropertiesPanel />
          </aside>
        </div>
      </DndController>

      {/* status bar */}
      <div className="flex h-8 flex-shrink-0 items-center gap-4 border-t border-slate-200 bg-white px-3 text-xs text-slate-500">
        <span>{doc.pages.length} page{doc.pages.length > 1 ? "s" : ""}</span>
        <span className="flex items-center gap-1">
          <button type="button" className="rounded px-1 hover:bg-slate-100" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}>−</button>
          {Math.round(zoom * 100)}%
          <button type="button" className="rounded px-1 hover:bg-slate-100" onClick={() => setZoom((z) => Math.min(1.6, Math.round((z + 0.1) * 10) / 10))}>+</button>
        </span>
        <span className="ml-auto">
          {saveState === "saving" ? "Saving…" : dirty ? "Unsaved changes" : saveState === "saved" ? "All changes saved" : "Saved"}
        </span>
      </div>
    </div>
  );
}
