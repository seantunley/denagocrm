"use client";

import { useState } from "react";
import Moveable from "react-moveable";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentPage } from "@/lib/doceditor/model";
import { blockBoxCss } from "@/lib/doceditor/blockBox";
import { alignmentGuides } from "./alignmentGuides";
import { BlockView } from "./BlockView";
import { useDocEditorEnv } from "./EditorContext";

/**
 * Free-placement content layer: blocks detached from the flow, absolutely
 * positioned and drag/resized with react-moveable. Coexists with the flow layer.
 */
export function FloatingLayer({ page, zoom }: { page: DocumentPage; zoom: number }) {
  const sel = useEditor((s) => s.sel);
  const select = useEditor((s) => s.select);
  const activeTextId = useEditor((s) => s.activeTextBlockId);
  const updateFloating = useEditor((s) => s.updateFloating);
  const picked = useEditor((s) => s.picked);
  const togglePick = useEditor((s) => s.togglePick);
  const dragPlacedTo = useEditor((s) => s.dragPlacedTo);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  // A freely placed block takes the document's type like any other (an email is drawn by its own renderer).
  const { email } = useDocEditorEnv();

  const selected = page.floatingBlocks.find((fb) => fb.block.id === sel.blockId) ?? null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {page.floatingBlocks.map((fb) => {
        const isSel = sel.blockId === fb.block.id;
        const active = activeTextId === fb.block.id;
        return (
          <div
            key={fb.id}
            data-float-id={fb.id}
            ref={isSel ? setTargetEl : undefined}
            // Shift-click adds it to (or takes it out of) a selection of several placed things.
            onMouseDown={(e) => { e.stopPropagation(); if (e.shiftKey) togglePick(fb.block.id); else select(fb.block.id); }}
            className={`pointer-events-auto absolute rounded bg-white/0 ${isSel ? "outline outline-2 outline-orange-400" : picked.includes(fb.block.id) ? "outline outline-2 outline-dashed outline-orange-400" : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-slate-300"}`}
            style={{ left: fb.x * zoom, top: fb.y * zoom, width: fb.width * zoom }}
          >
            {/* The block lays out at its real width and is zoomed as a whole, the
                same factor as its position — so a fixed-geometry block (the
                showcase acceptance card) keeps its lines under the overlay
                fields, which are also placed at `px × zoom`. */}
            <div className={email ? undefined : "doc-canvas"} style={{ zoom }}>
              {/* Text size and alignment apply to a freely placed block exactly as the PDF applies them. */}
              <div style={blockBoxCss(fb.block, "floating").inner}>
                <BlockView block={fb.block} active={active} />
              </div>
            </div>
          </div>
        );
      })}

      {selected && targetEl && (
        <Moveable
          target={targetEl}
          draggable resizable origin={false} throttleDrag={0}
          renderDirections={["e", "w"]}
          {...alignmentGuides(targetEl)}
          onDrag={({ target, left, top }) => { const el = target as HTMLElement; el.style.left = `${left}px`; el.style.top = `${top}px`; }}
          onDragEnd={({ target }) => {
            const el = target as HTMLElement;
            // The rest of a selection (or its group) follows by the same distance.
            dragPlacedTo(selected.block.id, { x: Math.max(0, parseFloat(el.style.left) / zoom), y: Math.max(0, parseFloat(el.style.top) / zoom) });
          }}
          onResize={({ target, width, drag }) => {
            const el = target as HTMLElement;
            el.style.width = `${width}px`; el.style.left = `${drag.left}px`;
          }}
          onResizeEnd={({ target }) => {
            const el = target as HTMLElement;
            updateFloating(selected.block.id, { width: Math.max(60, parseFloat(el.style.width) / zoom), x: Math.max(0, parseFloat(el.style.left) / zoom) });
          }}
        />
      )}
    </div>
  );
}
