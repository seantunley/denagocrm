"use client";

import type { TableStyle } from "@/lib/doceditor/model";
import { TABLE_BORDERS, TABLE_DENSITIES } from "@/lib/doceditor/tableStyle";

const lbl = "block text-[11px] font-medium text-slate-500 mb-1";
const inp = "w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-orange-400 focus:outline-none";
const check = "flex items-center gap-2 text-sm text-slate-700";

/**
 * How a table is drawn — the same five choices for the plain table, the
 * line-items table and the pricing table. Each is stored only when it differs
 * from the standard look, so a table nobody has touched stays exactly as it was.
 */
export function TableStyleControls({ value, onChange }: { value: TableStyle; onChange: (next: TableStyle) => void }) {
  const style = value ?? {};
  // Setting a choice back to the standard removes it; an empty style is no style.
  const set = (patch: NonNullable<TableStyle>) => {
    const next = { ...style, ...patch } as Record<string, unknown>;
    if (next.density === "normal") delete next.density;
    if (next.borders === "rows") delete next.borders;
    if (next.zebra === true) delete next.zebra;
    if (next.repeatHeader === true) delete next.repeatHeader;
    if (next.keepRows === false) delete next.keepRows;
    onChange(Object.keys(next).length ? (next as TableStyle) : undefined);
  };
  return (
    <div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div><label className={lbl}>Row spacing</label>
          <select className={inp} value={style.density ?? "normal"} onChange={(e) => set({ density: e.target.value as NonNullable<TableStyle>["density"] })}>
            {TABLE_DENSITIES.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
        <div><label className={lbl}>Lines</label>
          <select className={inp} value={style.borders ?? "rows"} onChange={(e) => set({ borders: e.target.value as NonNullable<TableStyle>["borders"] })}>
            {TABLE_BORDERS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <label className={check}><input type="checkbox" checked={style.zebra !== false} onChange={(e) => set({ zebra: e.target.checked })} /> Tint alternate rows</label>
        <label className={check}><input type="checkbox" checked={style.repeatHeader !== false} onChange={(e) => set({ repeatHeader: e.target.checked })} /> Repeat the heading on each page</label>
        <label className={check}><input type="checkbox" checked={!!style.keepRows} onChange={(e) => set({ keepRows: e.target.checked })} /> Never split a row across two pages</label>
      </div>
    </div>
  );
}
