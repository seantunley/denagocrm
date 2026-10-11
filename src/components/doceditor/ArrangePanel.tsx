"use client";

import { useEditor } from "@/lib/doceditor/store";
import { uid } from "@/lib/doceditor/factory";
import { alignRects, distributeRects, findPlaced, groupMembers, matchWidths, movePlaced, pageBox, placedRects, setGroup, type AlignMode } from "@/lib/doceditor/arrange";
import type { DocumentModel } from "@/lib/doceditor/model";

const btn = "flex-1 rounded border border-slate-300 px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40";
const lbl = "block text-[11px] font-medium text-slate-500 mb-1";

/**
 * How tall each freely placed block is on the page right now. A block's height
 * is decided by its content, not stored — so lining up bottoms or middles, and
 * spacing things down the page, has to measure it. Unzoomed px.
 */
function measuredHeights(doc: DocumentModel, ids: string[]): Record<string, number> {
  const heights: Record<string, number> = {};
  for (const fb of doc.pages.flatMap((p) => p.floatingBlocks)) {
    if (!ids.includes(fb.block.id)) continue;
    const box = document.querySelector(`[data-float-id="${CSS.escape(fb.id)}"]`)?.getBoundingClientRect();
    if (box && box.width > 0) heights[fb.block.id] = box.height / (box.width / fb.width);
  }
  return heights;
}

const rectsOf = (doc: DocumentModel, ids: string[]) => {
  const at = findPlaced(doc, ids[0]);
  return at ? placedRects(doc.pages[at.pageIdx], ids, measuredHeights(doc, ids)) : {};
};

const MODES: [AlignMode, string, string][] = [
  ["left", "⇤", "left edges"], ["centre", "↔", "centres, across"], ["right", "⇥", "right edges"],
  ["top", "⤒", "top edges"], ["middle", "↕", "middles, down"], ["bottom", "⤓", "bottom edges"],
];

const PAGE_TITLES: Record<AlignMode, string> = { left: "To the left", centre: "To the centre, across", right: "To the right", top: "To the top", middle: "To the middle, down", bottom: "To the bottom" };

/** Line ONE placed thing up on its page — within the margins. Shown with its position fields. */
export function AlignOnPage({ id }: { id: string }) {
  const arrange = useEditor((s) => s.arrange);
  return (
    <div className="mb-3">
      <label className={lbl}>Line up on the page</label>
      <div className="flex gap-1">
        {MODES.map(([mode, icon]) => (
          <button key={mode} type="button" className={btn} title={`${PAGE_TITLES[mode]} of the page (inside its margins)`} aria-label={`Line up on the page: ${mode}`} onClick={() => arrange((d) => movePlaced(d, alignRects(rectsOf(d, [id]), mode, pageBox(d))))}>{icon}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Several placed things selected: line them up with each other, space them
 * evenly, give them one width, and group them so they stay together.
 */
export function ArrangePanel({ ids }: { ids: string[] }) {
  const doc = useEditor((s) => s.doc);
  const arrange = useEditor((s) => s.arrange);
  const removePicked = useEditor((s) => s.removePicked);
  const select = useEditor((s) => s.select);
  if (!doc) return null;
  const isGroup = groupMembers(doc, ids[0]).length === ids.length && ids.length >= 2 && ids.every((id) => groupMembers(doc, id).length === ids.length);
  return (
    <div className="p-3">
      <div className="mb-3 text-sm font-medium text-slate-700">{ids.length} items selected{isGroup ? " · grouped" : ""}</div>
      <label className={lbl}>Line up with each other</label>
      <div className="mb-3 flex gap-1">
        {MODES.map(([mode, icon, what]) => (
          <button key={mode} type="button" className={btn} title={`Line up their ${what}`} aria-label={`Line up: ${mode}`} onClick={() => arrange((d) => movePlaced(d, alignRects(rectsOf(d, ids), mode)))}>{icon}</button>
        ))}
      </div>
      <label className={lbl}>Space evenly{ids.length < 3 ? " — needs three or more" : ""}</label>
      <div className="mb-3 flex gap-1">
        <button type="button" className={btn} disabled={ids.length < 3} onClick={() => arrange((d) => movePlaced(d, distributeRects(rectsOf(d, ids), "across")))}>Across</button>
        <button type="button" className={btn} disabled={ids.length < 3} onClick={() => arrange((d) => movePlaced(d, distributeRects(rectsOf(d, ids), "down")))}>Down</button>
        <button type="button" className={btn} title="Give them all the width of the widest" onClick={() => arrange((d) => matchWidths(d, ids))}>Same width</button>
      </div>
      <div className="mb-3 flex gap-1">
        {isGroup
          ? <button type="button" className={btn} onClick={() => arrange((d) => setGroup(d, ids, null))}>Ungroup</button>
          : <button type="button" className={btn} title="Keep these together: click one to select them all, drag one to move them all" onClick={() => arrange((d) => setGroup(d, ids, uid()))}>Group</button>}
        <button type="button" className={btn} onClick={() => select(null)}>Clear selection</button>
      </div>
      <button type="button" onClick={removePicked} className="w-full rounded-md border border-red-200 py-1.5 text-sm text-red-600 hover:bg-red-50">Delete {ids.length} items</button>
      <p className="mt-3 text-[11px] text-slate-400">Shift-click a freely placed block or a signing field to add it to the selection, or take it out. Drag one and the rest follow. Arrow keys nudge by 1px (hold Shift for 10).</p>
    </div>
  );
}
