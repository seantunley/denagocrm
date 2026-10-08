"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDocEditorEnv } from "./EditorContext";
import { emailFramePreview } from "@/lib/doceditor/emailRender";
import { useDraggable } from "@dnd-kit/core";
import { useEditor } from "@/lib/doceditor/store";
import { newBlock } from "@/lib/doceditor/factory";
import { PAGE_SIZES, type DocumentBlock, type DocumentPage, type DocumentRow, type DocumentColumn } from "@/lib/doceditor/model";
import { BlockView } from "./BlockView";
import { OverlayLayer } from "./OverlayLayer";
import { FloatingLayer } from "./FloatingLayer";
import { useDropHint, type DragData, type Hint } from "./DndController";

export function Canvas({ zoom }: { zoom: number }) {
  const doc = useEditor((s) => s.doc);
  const select = useEditor((s) => s.select);
  const hint = useDropHint();

  const { email } = useDocEditorEnv();
  // An email is drawn in its frame: the frame's own colours, and — around a
  // message — the header above it and the signature and footer below, exactly
  // as they send. On the frame itself those are its own (editable) blocks.
  const frameDoc = email ? (email.kind ? email.frame?.doc : doc) : null;
  const frame = useMemo(
    () => (email && frameDoc ? emailFramePreview(frameDoc, { ...email.sample, sender_name: email.sample.sender_name || "Your name" }, email.brand) : null),
    [email, frameDoc],
  );

  if (!doc) return null;
  const size = PAGE_SIZES[doc.style.pageSize];
  const around = email && frame ? { ...frame, message: !!email.kind, href: email.frame?.href ?? null } : undefined;

  return (
    <div className="flex flex-col items-center gap-10 py-10" style={frame ? { background: frame.page } : undefined} onMouseDown={() => select(null)}>
      {doc.pages.map((page, pIdx) => (
        <PageView key={page.id} page={page} pIdx={pIdx} zoom={zoom} size={size} margin={doc.style.margin} fontFamily={doc.style.fontFamily} hint={hint} email={around} />
      ))}
    </div>
  );
}

type EmailAround = { top: string; bottom: string; card: string; message: boolean; href: string | null };

/**
 * The shared frame around a message — shown so the email is edited as it is
 * sent, not editable here (it belongs to every email): one click opens it.
 * Our own renderer's escaped markup, with sample details.
 */
function FramePart({ html, href, zoom }: { html: string; href: string | null; zoom: number }) {
  if (!html) return null;
  return (
    <div className="group/frame relative" onMouseDown={(e) => e.stopPropagation()}>
      <div style={{ zoom }} dangerouslySetInnerHTML={{ __html: html }} />
      {href && (
        <a
          href={href} target="_blank" rel="noreferrer"
          title="The header, signature and footer are shared by every customer email. Opens the frame in a new tab."
          className="absolute inset-0 flex items-start justify-end rounded-sm p-2 outline-dashed outline-1 -outline-offset-1 outline-transparent transition hover:bg-orange-400/5 hover:outline-orange-400"
        >
          <span className="rounded-full bg-slate-900/80 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm group-hover/frame:bg-orange-500">
            Shared frame · Edit ↗
          </span>
        </a>
      )}
    </div>
  );
}

/**
 * One page of the canvas, with the sheet's real edge drawn on it.
 *
 * The page box only ever set a MIN height, so a page whose content outgrew A4
 * simply got taller and still looked like one sheet. The renderer paginates for
 * real, so the first anyone knew of it was the preview arriving with an extra
 * page and no clue which block had pushed it there. The guides below put that
 * boundary back where the designer can see it.
 */
function PageView({
  page, pIdx, zoom, size, margin, fontFamily, hint, email,
}: {
  page: DocumentPage; pIdx: number; zoom: number;
  size: { w: number; h: number }; margin: number;
  fontFamily: "sans" | "serif" | "mono"; hint: Hint;
  email?: EmailAround;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sheet = size.h * zoom;
  // How many sheets this page's content will actually print onto.
  // An email is one continuous card, never paginated.
  const sheets = email ? 1 : Math.max(1, Math.ceil(height / sheet - 0.001));

  return (
    <div
      ref={ref}
      data-page-idx={pIdx}
      className="relative bg-white shadow-lg ring-1 ring-black/5"
      // Ink on paper whatever the app's theme: the sheet is white, so its text must never inherit the dark theme's light foreground.
      style={{ width: size.w * zoom, minHeight: sheet, color: "#0f172a", ...(email ? { background: email.card, borderRadius: 16 * zoom, overflow: "hidden" } : {}) }}
    >
      {email?.message && <FramePart html={email.top} href={email.href} zoom={zoom} />}
      {/* An email has no page margin of its own: a message sits where the frame's
          slot puts it, and the frame's header and footer run edge to edge. */}
      <div className="relative" style={{ padding: email ? (email.message ? `${34 * zoom}px ${margin * zoom}px ${4 * zoom}px` : `${14 * zoom}px ${margin * zoom}px 0`) : margin * zoom }}>
        {/* CSS `zoom`, not just zoomed box sizes: the page, its margins and every
            floating block / overlay field are placed at `px × zoom`, so the
            CONTENT has to scale by the same factor or it lays out at 100% inside
            a 90% box — wrapping differently from print, and leaving fixed-height
            content (a signature line) where no overlay field expects it. */}
        {/* Sans is Geist — the app's own copy of the font the renderer embeds as
            the document face — so text wraps on the canvas as it prints. */}
        <div style={{ zoom, fontFamily: fontFamily === "serif" ? "Georgia,serif" : fontFamily === "mono" ? "monospace" : "var(--font-geist-sans),Helvetica,Arial,sans-serif" }}>
          {page.rows.map((row) => <RowView key={row.id} row={row} hint={hint} />)}
        </div>
        <AddRowButton pageIdx={pIdx} active={!!hint && "pageIdx" in hint && hint.pageIdx === pIdx} />
      </div>
      {email?.message && <FramePart html={email.bottom} href={email.href} zoom={zoom} />}
      <FloatingLayer page={page} zoom={zoom} />
      <OverlayLayer page={page} zoom={zoom} />
      <div className="pointer-events-none absolute -top-6 left-0 text-[11px] font-medium text-slate-400">Page {pIdx + 1}</div>

      {/* Where the paper actually ends. Anything below a line prints on the next
          sheet, whatever this one looks like on screen. */}
      {Array.from({ length: sheets - 1 }, (_, i) => (
        <div
          key={i}
          className="pointer-events-none absolute inset-x-0 border-t-2 border-dashed border-rose-400/70"
          style={{ top: sheet * (i + 1) }}
        >
          <span className="absolute right-1 -top-5 rounded bg-rose-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            Page break — overflows onto sheet {i + 2}
          </span>
        </div>
      ))}
      {sheets > 1 && (
        <div className="pointer-events-none absolute -top-6 right-0 text-[11px] font-medium text-rose-500">
          Prints on {sheets} sheets
        </div>
      )}
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
    <div
      ref={rowRef}
      className="relative grid"
      style={{
        gridTemplateColumns: template,
        gap: row.settings?.gap ?? 16,
        // A row with its own padding owns its spacing — as serialize.ts rowSpacing().
        ...(row.settings?.padding
          ? { margin: 0, padding: `${row.settings.padding.top ?? 0}px ${row.settings.padding.right ?? 0}px ${row.settings.padding.bottom ?? 0}px ${row.settings.padding.left ?? 0}px` }
          : { margin: "3px 0" }),
      }}
    >
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
