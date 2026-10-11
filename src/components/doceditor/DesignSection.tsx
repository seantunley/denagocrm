"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/lib/doceditor/store";
import type { DocumentBlock, LayoutSettings, BoxSpacing } from "@/lib/doceditor/model";
import { FIXED_GEOMETRY, pickStyle, styleCount, withoutStyle } from "@/lib/doceditor/blockBox";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const num = "w-full rounded-md border border-slate-300 px-1.5 py-1 text-xs text-slate-800";
const row = "mb-3";

/**
 * The same design controls for every block — flowed or freely placed.
 *
 * What a block offered used to depend on which block it was: a divider had a
 * colour, an info card an accent, a table nothing at all, and none had spacing
 * or a border. Tuning a layout meant adding spacer blocks. These are the
 * controls every block shares; a block's own controls (its colours, its
 * columns) stay in its own section above.
 *
 * Blocks whose geometry is fixed for signing (the acceptance card, the footer
 * band, the showcase header) take the type settings only, and say why.
 */
export function DesignSection({ block, floating }: { block: DocumentBlock; floating: boolean }) {
  const updateBlock = useEditor((s) => s.updateBlock);
  const clipboard = useEditor((s) => s.styleClipboard);
  const copyStyle = useEditor((s) => s.copyStyle);
  const s: LayoutSettings = block.settings ?? {};
  const fixed = FIXED_GEOMETRY.has(block.type);
  const [linked, setLinked] = useState(() => {
    const p = s.padding;
    return !p || (p.top === p.right && p.right === p.bottom && p.bottom === p.left);
  });
  // An unset value is removed, not stored as undefined-looking noise.
  const set = (patch: Partial<LayoutSettings>) => {
    const next: Record<string, unknown> = { ...s, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    updateBlock(block.id, { settings: next } as Partial<DocumentBlock>);
  };
  const side = (box: BoxSpacing | undefined, key: keyof BoxSpacing) => box?.[key] ?? 0;
  const setPadding = (key: keyof BoxSpacing, value: number) => {
    const v = Math.max(0, Math.min(200, value || 0));
    const next: BoxSpacing = linked ? { top: v, right: v, bottom: v, left: v } : { top: side(s.padding, "top"), right: side(s.padding, "right"), bottom: side(s.padding, "bottom"), left: side(s.padding, "left"), [key]: v };
    set({ padding: Object.values(next).some((n) => (n ?? 0) > 0) ? next : undefined });
  };
  const setMargin = (key: "top" | "bottom", value: number) => {
    const next = { top: side(s.margin, "top"), bottom: side(s.margin, "bottom"), [key]: Math.max(0, Math.min(200, value || 0)) };
    set({ margin: next.top > 0 || next.bottom > 0 ? next : undefined });
  };
  const box = (label: string, value: number, onChange: (n: number) => void, max = 200, step = 1) => (
    <label className="flex-1 text-[10px] text-slate-500">{label}
      <input type="number" min={0} max={max} step={step} className={num} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
  const count = styleCount(s);

  return (
    <div className="border-b border-slate-100 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Design</span>
        {/* An override must never be invisible: say how many settings differ from the block's own design. */}
        {count > 0 && <span className="rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700" title="Settings that differ from this block's own design">{count} changed</span>}
      </div>

      {fixed ? (
        <p className="mb-3 rounded-md bg-slate-50 px-2.5 py-2 text-[11px] text-slate-500">This block has a fixed size so that signing fields and the foot of the page line up with it. It takes weight and letter spacing, but not spacing, a fill or a border.</p>
      ) : (
        <>
          <div className={row}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium text-slate-500">Padding (inside)</span>
              <label className="flex items-center gap-1 text-[10px] text-slate-500"><input type="checkbox" checked={linked} onChange={(e) => setLinked(e.target.checked)} />All sides the same</label>
            </div>
            {linked
              ? <div className="flex gap-1.5">{box("All sides", side(s.padding, "top"), (n) => setPadding("top", n))}</div>
              : <div className="flex gap-1.5">{box("Top", side(s.padding, "top"), (n) => setPadding("top", n))}{box("Right", side(s.padding, "right"), (n) => setPadding("right", n))}{box("Bottom", side(s.padding, "bottom"), (n) => setPadding("bottom", n))}{box("Left", side(s.padding, "left"), (n) => setPadding("left", n))}</div>}
          </div>
          {!floating && (
            <div className={row}>
              <span className={lbl}>Space outside</span>
              <div className="flex gap-1.5">{box("Above", side(s.margin, "top"), (n) => setMargin("top", n))}{box("Below", side(s.margin, "bottom"), (n) => setMargin("bottom", n))}</div>
            </div>
          )}
          <div className={row}>
            <span className={lbl}>Fill</span>
            <div className="flex items-center gap-1.5">
              <input type="color" aria-label="Fill colour" value={s.background || "#ffffff"} onChange={(e) => set({ background: e.target.value })} className="h-8 flex-1 rounded border border-slate-300" />
              <button type="button" className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-40" disabled={!s.background} onClick={() => set({ background: undefined })}>None</button>
            </div>
          </div>
          <div className={row}>
            <span className={lbl}>Border</span>
            <div className="flex items-end gap-1.5">
              <label className="flex-1 text-[10px] text-slate-500">Colour<input type="color" aria-label="Border colour" value={s.borderColor || "#cbd5e1"} onChange={(e) => set({ borderColor: e.target.value, borderWidth: s.borderWidth || 1 })} className="h-[26px] w-full rounded border border-slate-300" /></label>
              {box("Thickness", s.borderWidth ?? 0, (n) => set({ borderWidth: n > 0 ? Math.min(12, n) : undefined, ...(n > 0 ? {} : { borderColor: undefined }) }), 12)}
              {box("Corners", s.radius ?? 0, (n) => set({ radius: n > 0 ? Math.min(60, n) : undefined }), 60)}
            </div>
          </div>
          {!floating && (
            <div className={row}>
              <label className={lbl} htmlFor={`valign-${block.id}`}>In a row of columns, rest at the</label>
              <select id={`valign-${block.id}`} className={num} value={s.verticalAlignment ?? "top"} onChange={(e) => set({ verticalAlignment: e.target.value === "top" ? undefined : (e.target.value as "middle" | "bottom") })}>
                <option value="top">Top</option><option value="middle">Middle</option><option value="bottom">Bottom</option>
              </select>
            </div>
          )}
        </>
      )}

      <div className={row}>
        <span className={lbl}>Type</span>
        <div className="flex items-end gap-1.5">
          <label className="flex-1 text-[10px] text-slate-500">Weight
            <select className={num} value={s.fontWeight ?? ""} onChange={(e) => set({ fontWeight: (e.target.value || undefined) as LayoutSettings["fontWeight"] })}>
              <option value="">As designed</option><option value="normal">Regular</option><option value="medium">Medium</option><option value="bold">Bold</option>
            </select>
          </label>
          <label className="flex-1 text-[10px] text-slate-500">Line spacing
            <input type="number" min={0.8} max={3} step={0.1} placeholder="auto" className={num} value={s.lineHeight ?? ""} onChange={(e) => set({ lineHeight: e.target.value === "" ? undefined : Math.max(0.8, Math.min(3, Number(e.target.value))) })} />
          </label>
          <label className="flex-1 text-[10px] text-slate-500">Letter spacing
            <input type="number" min={-2} max={10} step={0.5} placeholder="0" className={num} value={s.letterSpacing ?? ""} onChange={(e) => set({ letterSpacing: e.target.value === "" || Number(e.target.value) === 0 ? undefined : Math.max(-2, Math.min(10, Number(e.target.value))) })} />
          </label>
        </div>
        <p className="mt-1 text-[10px] text-slate-400">Text size and alignment are under {floating ? "Placement" : "Layout"}. Branded blocks set some of their own weights and sizes, which these do not override.</p>
      </div>

      <div className="flex gap-1.5">
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50" onClick={() => { copyStyle(pickStyle(s)); toast.success("Style copied — select another block and paste"); }}>Copy style</button>
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={!clipboard} title={clipboard ? "Replace this block's style with the copied one" : "Copy a style first"}
          // Paste REPLACES the look and leaves where the block sits (its width, its place on the row) alone.
          onClick={() => clipboard && updateBlock(block.id, { settings: { ...withoutStyle(s), ...clipboard } } as Partial<DocumentBlock>)}>Paste style</button>
        <button type="button" className="flex-1 rounded-md border border-slate-300 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40" disabled={count === 0} onClick={() => updateBlock(block.id, { settings: withoutStyle(s) } as Partial<DocumentBlock>)}>Reset style</button>
      </div>
    </div>
  );
}
