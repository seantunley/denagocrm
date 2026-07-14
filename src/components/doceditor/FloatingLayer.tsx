"use client";

import { useState } from "react";
import Moveable from "react-moveable";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentPage } from "@/lib/doceditor/model";
import { BlockView } from "./BlockView";

/**
 * Free-placement content layer: blocks detached from the flow, absolutely
 * positioned and drag/resized with react-moveable. Coexists with the flow layer.
 */
export function FloatingLayer({ page, zoom }: { page: DocumentPage; zoom: number }) {
  const sel = useEditor((s) => s.sel);
  const select = useEditor((s) => s.select);
  const activeTextId = useEditor((s) => s.activeTextBlockId);
  const updateFloating = useEditor((s) => s.updateFloating);
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);

  const selected = page.floatingBlocks.find((fb) => fb.block.id === sel.blockId) ?? null;

  return (
    <div className="pointer-events-none absolute inset-0">
      {page.floatingBlocks.map((fb) => {
        const isSel = sel.blockId === fb.block.id;
        const active = activeTextId === fb.block.id;
        return (
          <div
            key={fb.id}
            ref={isSel ? setTargetEl : undefined}
            onMouseDown={(e) => { e.stopPropagation(); select(fb.block.id); }}
            className={`pointer-events-auto absolute rounded bg-white/0 ${isSel ? "outline outline-2 outline-orange-400" : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-slate-300"}`}
            style={{ left: fb.x * zoom, top: fb.y * zoom, width: fb.width * zoom }}
          >
            <BlockView block={fb.block} active={active} />
          </div>
        );
      })}

      {selected && targetEl && (
        <Moveable
          target={targetEl}
          draggable resizable origin={false} throttleDrag={0}
          renderDirections={["e", "w"]}
          onDrag={({ target, left, top }) => { const el = target as HTMLElement; el.style.left = `${left}px`; el.style.top = `${top}px`; }}
          onDragEnd={({ target }) => {
            const el = target as HTMLElement;
            updateFloating(selected.block.id, { x: Math.max(0, parseFloat(el.style.left) / zoom), y: Math.max(0, parseFloat(el.style.top) / zoom) });
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
