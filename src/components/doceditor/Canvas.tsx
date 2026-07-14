"use client";

import { useRef, useState } from "react";
import { useDraggable } from "@dnd-kit/core";
import { useEditor } from "@/lib/doceditor/store";
import { newBlock } from "@/lib/doceditor/factory";
import { PAGE_SIZES, type DocumentBlock, type DocumentRow, type DocumentColumn } from "@/lib/doceditor/model";
import { BlockView } from "./BlockView";
import { OverlayLayer } from "./OverlayLayer";
import { FloatingLayer } from "./FloatingLayer";
import { useDropHint, type DragData, type Hint } from "./DndController";

export function Canvas({ zoom }: { zoom: number }) {
  const doc = useEditor((s) => s.doc);
  const select = useEditor((s) => s.select);
  const hint = useDropHint();

  if (!doc) return null;
  const size = PAGE_SIZES[doc.style.pageSize];

  return (
    <div className="flex flex-col items-center gap-10 py-10" onMouseDown={() => select(null)}>
      {doc.pages.map((page, pIdx) => (
        <div
          key={page.id}
          data-page-idx={pIdx}
          className="relative bg-white shadow-lg ring-1 ring-black/5"
          style={{ width: size.w * zoom, minHeight: size.h * zoom }}
        >
          <div className="relative" style={{ padding: doc.style.margin * zoom }}>
            <div style={{ fontFamily: doc.style.fontFamily === "serif" ? "Georgia,serif" : doc.style.fontFamily === "mono" ? "monospace" : "Helvetica,Arial,sans-serif" }}>
              {page.rows.map((row) => <RowView key={row.id} row={row} hint={hint} />)}
            </div>
            <AddRowButton pageIdx={pIdx} active={!!hint && "pageIdx" in hint && hint.pageIdx === pIdx} />
          </div>
          <FloatingLayer page={page} zoom={zoom} />
          <OverlayLayer page={page} zoom={zoom} />
          <div className="pointer-events-none absolute -top-6 left-0 text-[11px] font-medium text-slate-400">Page {pIdx + 1}</div>
        </div>
      ))}
    </div>
  );
}

function RowView({ row, hint }: { row: DocumentRow; hint: Hint }) {
  const setColumnWidths = useEditor((s) => s.setColumnWidths);
  const [live, setLive] = useState<number[] | null>(null);
  const dividerDrag = useRef<{ i: number; startX: number; base: number[]; rowWidth: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  const widths = live ?? row.columns.map((c) => c.widthPercent);
  const template = widths.map((w) => `${w}fr`).join(" ");

  const onDividerDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const rowWidth = rowRef.current?.getBoundingClientRect().width ?? 1;
    dividerDrag.current = { i, startX: e.clientX, base: row.columns.map((c) => c.widthPercent), rowWidth };
    setLive(row.columns.map((c) => c.widthPercent));
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch {}
  };
  const onDividerMove = (e: React.PointerEvent) => {
    const d = dividerDrag.current; if (!d) return;
    const deltaPct = ((e.clientX - d.startX) / d.rowWidth) * 100;
    const w = [...d.base];
    const min = 8;
    const left = w[d.i] + deltaPct;
    const right = w[d.i + 1] - deltaPct;
    if (left >= min && right >= min) { w[d.i] = left; w[d.i + 1] = right; setLive(w); }
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = dividerDrag.current;
    dividerDrag.current = null;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
    if (d && live) setColumnWidths(row.id, live);
    setLive(null);
  };

  return (
    <div ref={rowRef} className="relative grid" style={{ gridTemplateColumns: template, gap: row.settings?.gap ?? 16, margin: "3px 0" }}>
      {row.columns.map((col, ci) => (
        <div key={col.id} className="relative min-w-0">
          <ColumnView col={col} hint={hint} />
          {ci < row.columns.length - 1 && (
            <div
              onPointerDown={onDividerDown(ci)} onPointerMove={onDividerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
              className="group absolute top-0 z-20 flex h-full w-5 cursor-col-resize touch-none items-center justify-center"
              style={{ right: `calc(-${(row.settings?.gap ?? 16) / 2}px - 10px)` }}
              title="Drag to resize columns"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="h-10 w-1.5 rounded-full bg-slate-300 opacity-40 transition group-hover:bg-orange-400 group-hover:opacity-100" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function ColumnView({ col, hint }: { col: DocumentColumn; hint: Hint }) {
  return (
    <div className="min-w-0">
      {col.blocks.map((b) => <BlockWrapper key={b.id} block={b} hint={hint} />)}
    </div>
  );
}

function BlockWrapper({ block, hint }: { block: DocumentBlock; hint: Hint }) {
  const sel = useEditor((s) => s.sel);
  const activeTextId = useEditor((s) => s.activeTextBlockId);
  const select = useEditor((s) => s.select);
  const duplicate = useEditor((s) => s.duplicate);
  const remove = useEditor((s) => s.remove);
  const toggleLock = useEditor((s) => s.toggleLock);
  const toggleHide = useEditor((s) => s.toggleHide);
  const detach = useEditor((s) => s.detach);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef } = useDraggable({
    id: `block-${block.id}`, data: { source: "move", blockId: block.id } satisfies DragData, disabled: block.locked,
  });

  const selected = sel.blockId === block.id;
  const active = activeTextId === block.id;
  const showHint = hint && "targetId" in hint && hint.targetId === block.id ? hint.zone : null;

  const w = block.settings?.width;
  const align = block.settings?.horizontalAlignment;
  const boxStyle: React.CSSProperties = w && w < 100
    ? { width: `${w}%`, marginLeft: align === "right" || align === "centre" ? "auto" : undefined, marginRight: align === "left" || align === "centre" || align === undefined || align === "stretch" ? "auto" : undefined }
    : {};

  return (
    <div
      ref={setNodeRef}
      data-block-id={block.id}
      onMouseDown={(e) => { e.stopPropagation(); select(block.id); }}
      className={`group relative my-0.5 rounded ${selected ? "outline outline-2 outline-orange-400" : "hover:outline hover:outline-1 hover:outline-slate-300"} ${block.hidden ? "opacity-40" : ""}`}
      style={{ padding: 2, ...boxStyle }}
    >
      <button
        ref={setActivatorNodeRef} {...listeners} {...attributes}
        className={`absolute -left-6 top-1 z-20 h-6 w-5 cursor-grab rounded text-slate-400 opacity-0 hover:bg-slate-100 group-hover:opacity-100 ${block.locked ? "cursor-not-allowed" : ""}`}
        title={block.locked ? "Locked" : "Drag to move"} type="button" onMouseDown={(e) => e.stopPropagation()}
      >⠿</button>

      {selected && (
        <div className="absolute -top-3 right-1 z-20 flex items-center gap-0.5 rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] shadow-sm" onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className="px-1 hover:text-orange-600" title="Duplicate" onClick={() => duplicate(block.id)}>⧉</button>
          <button type="button" className="px-1 hover:text-orange-600" title="Free placement (drag anywhere)" onClick={() => detach(block.id)}>⤢</button>
          <button type="button" className="px-1 hover:text-orange-600" title={block.locked ? "Unlock" : "Lock"} onClick={() => toggleLock(block.id)}>{block.locked ? "🔒" : "🔓"}</button>
          <button type="button" className="px-1 hover:text-orange-600" title={block.hidden ? "Show" : "Hide"} onClick={() => toggleHide(block.id)}>{block.hidden ? "🙈" : "👁"}</button>
          <button type="button" className="px-1 text-red-500 hover:text-red-700" title="Delete" onClick={() => remove(block.id)}>🗑</button>
        </div>
      )}

      <BlockView block={block} active={active} />

      {showHint === "above" && <Indicator kind="h" pos="top" />}
      {showHint === "below" && <Indicator kind="h" pos="bottom" />}
      {showHint === "left" && <Indicator kind="v" pos="left" />}
      {showHint === "right" && <Indicator kind="v" pos="right" />}
      {showHint === "centre" && <div className="pointer-events-none absolute inset-0 rounded bg-orange-400/15 ring-2 ring-orange-400" />}
    </div>
  );
}

function Indicator({ kind, pos }: { kind: "h" | "v"; pos: "top" | "bottom" | "left" | "right" }) {
  const base = "pointer-events-none absolute z-30 bg-orange-500";
  if (kind === "h") return <div className={`${base} left-0 right-0 h-1 rounded ${pos === "top" ? "-top-1" : "-bottom-1"}`} />;
  return <div className={`${base} top-0 bottom-0 w-1 rounded ${pos === "left" ? "-left-1" : "-right-1"}`} />;
}

function AddRowButton({ pageIdx, active }: { pageIdx: number; active: boolean }) {
  const appendToPage = useEditor((s) => s.appendToPage);
  return (
    <button
      type="button"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={() => appendToPage(pageIdx, newBlock("text"))}
      className={`mt-2 flex w-full items-center justify-center gap-1 rounded border border-dashed py-2 text-xs transition ${active ? "border-orange-400 bg-orange-50 text-orange-600" : "border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-500"}`}
    >
      ＋ Add a block here
    </button>
  );
}
