"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentBlock } from "@/lib/doceditor/model";
import { describeSection, sectionFromBlocks, type LibrarySection } from "@/lib/doceditor/librarySection";
import { blockBoxCss } from "@/lib/doceditor/blockBox";
import { listLibraryItems, deleteLibraryItem } from "@/app/actions/doclibrary";
import { listClauseBlocks } from "@/app/actions/customDocuments";
import ConfirmActionDialog from "@/components/ConfirmActionDialog";
import { BlockView } from "./BlockView";

type LibItem = { id: string; name: string; category: string | null; blocks: DocumentBlock[]; section?: LibrarySection };

// The content library needs docbuilder.manage; a custom document is edited with
// documents.manage. Someone without it gets an empty library, not a stuck spinner.
const loadLibrary = () => listLibraryItems().then((r) => r as LibItem[], () => [] as LibItem[]);
const loadClauses = () => listClauseBlocks().then((r) => r as LibItem[], () => [] as LibItem[]);
const sectionOf = (item: LibItem): LibrarySection => item.section ?? sectionFromBlocks(item.blocks);

/**
 * A small picture of a saved section: its rows drawn by the editor's own block
 * renderer at a fraction of their size, so an item is recognised by sight and
 * not only by the name somebody gave it. Freely placed blocks are stacked under
 * the rows. Nothing in it can be clicked or typed into.
 */
function SectionPreview({ section }: { section: LibrarySection }) {
  const WIDTH = 640;
  const SCALE = 0.3;
  return (
    <div aria-hidden="true" className="pointer-events-none mt-1.5 overflow-hidden rounded border border-slate-100 bg-white" style={{ maxHeight: 96 }}>
      <div style={{ width: WIDTH, zoom: SCALE, padding: 12, color: "#0f172a", fontSize: 14, lineHeight: 1.5 }}>
        {section.rows.map((row) => (
          <div key={row.id} style={{ display: "grid", gridTemplateColumns: row.columns.map((c) => `${c.widthPercent}fr`).join(" "), gap: row.settings?.gap ?? 16, margin: "3px 0" }}>
            {row.columns.map((col) => (
              <div key={col.id} style={{ minWidth: 0 }}>
                {col.blocks.map((b) => { const box = blockBoxCss(b, "flow"); return <div key={b.id} style={{ ...box.outer, ...box.inner }}><BlockView block={b} active={false} /></div>; })}
              </div>
            ))}
          </div>
        ))}
        {section.floats.map((fb) => <div key={fb.id} style={{ width: fb.width, marginTop: 6, ...blockBoxCss(fb.block, "floating").inner }}><BlockView block={fb.block} active={false} /></div>)}
      </div>
    </div>
  );
}

/** The Library palette: this workspace's saved sections, searchable and grouped, then Studio clauses. */
export function LibraryTab() {
  const insertLibrary = useEditor((s) => s.insertLibrary);
  const hasSelection = useEditor((s) => !!s.sel.blockId);
  const activePage = useEditor((s) => s.activePage);
  const [items, setItems] = useState<LibItem[]>([]);
  const [clauses, setClauses] = useState<LibItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const refresh = async () => { setLoading(true); setItems(await loadLibrary()); setClauses(await loadClauses()); setLoading(false); };
  useEffect(() => {
    let alive = true;
    Promise.all([loadLibrary(), loadClauses()]).then(([lib, cl]) => { if (alive) { setItems(lib); setClauses(cl); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  const categories = useMemo(() => [...new Set(items.map((i) => i.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)), [items]);
  const needle = search.trim().toLowerCase();
  const matches = (item: LibItem) => (!category || item.category === category) && (!needle || item.name.toLowerCase().includes(needle) || (item.category ?? "").toLowerCase().includes(needle));
  const shown = items.filter(matches);
  const shownClauses = clauses.filter((c) => !category && (!needle || c.name.toLowerCase().includes(needle)));
  const where = hasSelection ? "below the selected block" : `at the end of page ${activePage + 1}`;

  return (
    <>
      <div className="flex items-center justify-between px-1">
        <p className="text-[11px] text-slate-400">Click an item to add it {where}.</p>
        <button type="button" className="text-[11px] text-slate-400 hover:text-slate-600" aria-label="Reload the library" onClick={refresh}>↻</button>
      </div>
      {(items.length > 3 || clauses.length > 3 || search || category) && (
        <div className="flex gap-1.5">
          <input type="search" aria-label="Search the library" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800" />
          {categories.length > 0 && (
            <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-md border border-slate-300 px-1 py-1 text-xs text-slate-700">
              <option value="">All</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
        </div>
      )}
      {loading ? (
        <p className="p-3 text-xs text-slate-400">Loading…</p>
      ) : items.length === 0 ? (
        <p className="p-3 text-xs text-slate-400">Nothing saved yet. Select a block on the page → “Save to content library”. You can save one block, its whole row of columns, or a freely placed block with its signing fields.</p>
      ) : shown.length === 0 ? (
        <p className="p-3 text-xs text-slate-400">Nothing matches.</p>
      ) : (
        <div className="space-y-1.5">
          {shown.map((it) => {
            const section = sectionOf(it);
            return (
              <div key={it.id} className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-sm hover:border-orange-300">
                <div className="flex items-start gap-1">
                  <button type="button" className="min-w-0 flex-1 text-left text-slate-700" onClick={() => insertLibrary(section)} title={`Add to the document, ${where}`}>
                    <span className="block truncate font-medium">{it.name}</span>
                    <span className="block text-[10px] text-slate-400">{it.category ? `${it.category} · ` : ""}{describeSection(section)}</span>
                    <SectionPreview section={section} />
                  </button>
                  <ConfirmActionDialog
                    trigger={<button type="button" className="px-1 text-red-400 hover:text-red-600" aria-label={`Delete ${it.name} from the library`} title="Delete from the library">✕</button>}
                    title={`Delete “${it.name}” from the library?`}
                    description="Documents that already use it keep their copy — nothing in them changes. It goes to the Trash."
                    confirmLabel="Delete"
                    destructive
                    onConfirm={async () => { const result = await deleteLibraryItem(it.id); if (!result.ok) toast.error("That item is no longer in your library."); await refresh(); }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {shownClauses.length > 0 && (
        <>
          <p className="px-1 pt-3 text-[11px] font-medium text-slate-400">Clauses — copied in; edit them in Document Studio.</p>
          <div className="space-y-1.5">
            {shownClauses.map((it) => (
              <button key={it.id} type="button" className="block w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-sm text-slate-700 hover:border-orange-300" onClick={() => insertLibrary(sectionFromBlocks(it.blocks))} title={`Add this clause, ${where}`}>
                {it.name}{it.category ? <span className="ml-1 text-[10px] text-slate-400">{it.category}</span> : null}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
