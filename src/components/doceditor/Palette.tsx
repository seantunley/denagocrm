"use client";

import { useEffect, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useEditor } from "@/lib/doceditor/store";
import { newBlock, newOverlayField } from "@/lib/doceditor/factory";
import type { BlockType, DocumentBlock, OverlayField } from "@/lib/doceditor/model";
import type { DragData } from "./DndController";
import { listLibraryItems, deleteLibraryItem } from "@/app/actions/doclibrary";

const CONTENT: { type: BlockType; label: string; icon: string }[] = [
  { type: "text", label: "Text", icon: "¶" },
  { type: "heading", label: "Heading", icon: "H" },
  { type: "image", label: "Image", icon: "🖼" },
  { type: "pricing", label: "Pricing table", icon: "R" },
  { type: "table", label: "Table", icon: "▦" },
  { type: "divider", label: "Divider", icon: "―" },
  { type: "spacer", label: "Spacer", icon: "↕" },
  { type: "pageBreak", label: "Page break", icon: "⤓" },
  { type: "conditional", label: "Conditional", icon: "⌥" },
];

const BRANDED: { type: BlockType; label: string; icon: string }[] = [
  { type: "banner", label: "Brand banner", icon: "▬" },
  { type: "infoCard", label: "Info card", icon: "🪪" },
  { type: "lineItems", label: "Line items (bound)", icon: "≣" },
  { type: "totalBand", label: "Total band", icon: "∑" },
  { type: "terms", label: "Terms", icon: "§" },
  { type: "footer", label: "Footer", icon: "‗" },
];

const FIELDS: { kind: OverlayField["kind"]; label: string; icon: string }[] = [
  { kind: "signature", label: "Signature", icon: "✍" },
  { kind: "initials", label: "Initials", icon: "AB" },
  { kind: "date", label: "Date", icon: "📅" },
  { kind: "text", label: "Text field", icon: "﹍" },
  { kind: "checkbox", label: "Checkbox", icon: "☑" },
  { kind: "dropdown", label: "Dropdown", icon: "▾" },
];

const TABS = ["Content", "Fields", "Library"] as const;

type LibItem = { id: string; name: string; category: string | null; blocks: DocumentBlock[] };

function LibraryTab() {
  const insertLibrary = useEditor((s) => s.insertLibrary);
  const [items, setItems] = useState<LibItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = async () => { setLoading(true); setItems((await listLibraryItems()) as LibItem[]); setLoading(false); };
  useEffect(() => {
    let alive = true;
    listLibraryItems().then((r) => { if (alive) { setItems(r as LibItem[]); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  return (
    <>
      <div className="flex items-center justify-between px-1">
        <p className="text-[11px] text-slate-400">Saved blocks — click to add to the last page.</p>
        <button type="button" className="text-[11px] text-slate-400 hover:text-slate-600" onClick={refresh}>↻</button>
      </div>
      {loading ? (
        <p className="p-3 text-xs text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-3 text-xs text-slate-400">Nothing saved yet. Select a block on the page → “Save to content library”.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm hover:border-orange-300">
              <button type="button" className="flex-1 text-left text-slate-700" onClick={() => insertLibrary(it.blocks)} title="Insert into the document">
                {it.name}{it.category ? <span className="ml-1 text-[10px] text-slate-400">{it.category}</span> : null}
              </button>
              <button type="button" className="px-1 text-red-400 hover:text-red-600" title="Delete" onClick={async () => { await deleteLibraryItem(it.id); refresh(); }}>✕</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ContentItem({ type, label, icon }: { type: BlockType; label: string; icon: string }) {
  const appendToPage = useEditor((s) => s.appendToPage);
  const pageCount = useEditor((s) => s.doc?.pages.length ?? 1);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `new-${type}`, data: { source: "new", blockType: type } satisfies DragData,
  });
  return (
    <button
      ref={setNodeRef} {...listeners} {...attributes}
      type="button"
      onClick={() => appendToPage(pageCount - 1, newBlock(type))}
      title="Drag onto the page, or click to add at the end"
      className={`flex cursor-grab items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-sm text-slate-700 hover:border-orange-300 hover:bg-orange-50 ${isDragging ? "opacity-40" : ""}`}
    >
      <span className="grid h-6 w-6 place-items-center rounded bg-slate-100 text-xs">{icon}</span>
      {label}
    </button>
  );
}

export function Palette() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Content");
  const addField = useEditor((s) => s.addField);
  const selectField = useEditor((s) => s.selectField);

  const addOverlay = (kind: OverlayField["kind"]) => {
    const field = newOverlayField(kind);
    addField(0, field);
    selectField(field.id);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-slate-200 px-2 pt-2">
        {TABS.map((t) => (
          <button
            key={t} type="button" onClick={() => setTab(t)}
            className={`rounded-t-md px-3 py-1.5 text-xs font-medium ${tab === t ? "bg-white text-slate-800 shadow-[inset_0_-2px_0_#f97316]" : "text-slate-400 hover:text-slate-600"}`}
          >{t}</button>
        ))}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {tab === "Content" ? (
          <>
            <p className="px-1 text-[11px] text-slate-400">Drag onto the page — drop above, below, or beside another block to build columns.</p>
            <div className="grid grid-cols-1 gap-1.5">
              {CONTENT.map((c) => <ContentItem key={c.type} {...c} />)}
            </div>
            <p className="px-1 pt-2 text-[11px] font-medium text-slate-400">Branded (quote/proposal)</p>
            <div className="grid grid-cols-1 gap-1.5">
              {BRANDED.map((c) => <ContentItem key={c.type} {...c} />)}
            </div>
          </>
        ) : tab === "Fields" ? (
          <>
            <p className="px-1 text-[11px] text-slate-400">Click to add a field, then drag it anywhere on the page and assign a recipient.</p>
            <div className="grid grid-cols-2 gap-1.5">
              {FIELDS.map((f) => (
                <button
                  key={f.kind} type="button" onClick={() => addOverlay(f.kind)}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-2 text-left text-xs text-slate-700 hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className="grid h-5 w-5 place-items-center rounded bg-slate-100 text-[10px]">{f.icon}</span>
                  {f.label}
                </button>
              ))}
            </div>
          </>
        ) : (
          <LibraryTab />
        )}
      </div>
    </div>
  );
}
