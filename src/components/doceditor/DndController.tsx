"use client";

import { createContext, useContext, useRef, useState, useCallback } from "react";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  type DragStartEvent, type DragMoveEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { useEditor } from "@/lib/doceditor/store";
import { getBlock, type DropZone } from "@/lib/doceditor/ops";
import { newBlock } from "@/lib/doceditor/factory";
import type { DocumentBlock, BlockType } from "@/lib/doceditor/model";

export type DragData = { source: "new"; blockType: BlockType } | { source: "move"; blockId: string };
export type Hint = { targetId: string; zone: DropZone } | { pageIdx: number; zone: "append" } | null;

const HintContext = createContext<Hint>(null);
export const useDropHint = () => useContext(HintContext);

function zoneFromRect(r: DOMRect, x: number, y: number): DropZone {
  const rx = (x - r.left) / r.width, ry = (y - r.top) / r.height;
  if (ry < 0.22) return "above";
  if (ry > 0.78) return "below";
  if (rx < 0.3) return "left";
  if (rx > 0.7) return "right";
  return "centre";
}

/** Owns the whole drag lifecycle (palette → canvas and block → block) and shares the live drop hint. */
export function DndController({ children }: { children: React.ReactNode }) {
  const dropRelative = useEditor((s) => s.dropRelative);
  const appendToPage = useEditor((s) => s.appendToPage);
  const moveToPage = useEditor((s) => s.moveToPage);

  const [drag, setDrag] = useState<DragData | null>(null);
  const [hint, setHint] = useState<Hint>(null);
  const startPtr = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const hintRef = useRef<Hint>(null);

  const setHintBoth = useCallback((h: Hint) => { hintRef.current = h; setHint(h); }, []);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => {
    const ev = e.activatorEvent as PointerEvent;
    startPtr.current = { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
    setHintBoth(null);
    setDrag((e.active.data.current as DragData) ?? null);
  };

  const onDragMove = useCallback((e: DragMoveEvent) => {
    const x = startPtr.current.x + e.delta.x, y = startPtr.current.y + e.delta.y;
    const data = e.active.data.current as DragData | undefined;
    const moveId = data?.source === "move" ? data.blockId : null;
    const els = document.elementsFromPoint(x, y);
    const blockEl = els.find((el) => el instanceof HTMLElement && el.dataset.blockId) as HTMLElement | undefined;
    if (blockEl && blockEl.dataset.blockId !== moveId) {
      setHintBoth({ targetId: blockEl.dataset.blockId!, zone: zoneFromRect(blockEl.getBoundingClientRect(), x, y) });
      return;
    }
    const pageEl = els.find((el) => el instanceof HTMLElement && el.dataset.pageIdx) as HTMLElement | undefined;
    setHintBoth(pageEl ? { pageIdx: Number(pageEl.dataset.pageIdx), zone: "append" } : null);
  }, [setHintBoth]);

  const onDragEnd = (e: DragEndEvent) => {
    const h = hintRef.current;
    const data = e.active.data.current as DragData | undefined;
    setDrag(null); setHint(null);
    if (!data || !h) return;
    const moveId = data.source === "move" ? data.blockId : undefined;
    const incoming: DocumentBlock =
      data.source === "new" ? newBlock(data.blockType)
        : (getBlock(useEditor.getState().doc, data.blockId) as DocumentBlock);
    if (!incoming) return;
    if ("targetId" in h) dropRelative(h.targetId, h.zone, incoming, moveId);
    else if (moveId) moveToPage(moveId, h.pageIdx);
    else appendToPage(h.pageIdx, incoming);
  };

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragMove={onDragMove} onDragEnd={onDragEnd}>
      <HintContext.Provider value={hint}>{children}</HintContext.Provider>
      <DragOverlay dropAnimation={null}>
        {drag ? (
          <div className="rounded-md border border-orange-400 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-lg">
            {drag.source === "new" ? `+ ${drag.blockType}` : "Moving block"}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
