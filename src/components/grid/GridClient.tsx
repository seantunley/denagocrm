"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Columns3 } from "lucide-react";
import { toast } from "sonner";
import { saveGridPrefs } from "@/app/actions/grid";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ActionResult } from "@/lib/actionResultTypes";
import {
  EMPTY_SELECTION,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  selectAllMatching,
  selectedCount,
  togglePage,
  toggleRow,
  type GridColumnDef,
  type GridPrefs,
  type GridSelection,
  type SelectionRequest,
} from "@/lib/grid/grid";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------- layout menu */

/** The person's own layout for this list: which columns, in what order, how wide, how dense. */
export function GridSettings({ gridId, columns, prefs }: { gridId: string; columns: readonly GridColumnDef[]; prefs: GridPrefs }) {
  const [draft, setDraft] = useState(prefs);
  const [pending, start] = useTransition();
  const byId = new Map(columns.map((c) => [c.id, c]));
  const order = draft.order.filter((id) => byId.has(id));

  const move = (id: string, by: -1 | 1) => {
    const next = [...draft.order];
    const i = next.indexOf(id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setDraft({ ...draft, order: next });
  };
  const save = (value: GridPrefs | null) =>
    start(async () => {
      const result = await saveGridPrefs(gridId, value);
      if (result.error) toast.error(result.error);
      else toast.success(result.success ?? "Saved");
    });

  return (
    <Popover onOpenChange={(open) => open && setDraft(prefs)}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" aria-label="Columns and density" title="Columns and density">
          <Columns3 className="size-4" />
          Columns
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <fieldset className="space-y-1.5">
          <legend className="text-xs font-semibold text-muted-foreground">Row height</legend>
          <div className="flex gap-1.5">
            {(["comfortable", "compact"] as const).map((d) => (
              <Button key={d} type="button" size="sm" variant={draft.density === d ? "secondary" : "ghost"} aria-pressed={draft.density === d} onClick={() => setDraft({ ...draft, density: d })}>
                {d === "comfortable" ? "Comfortable" : "Compact"}
              </Button>
            ))}
          </div>
        </fieldset>
        <fieldset className="space-y-1">
          <legend className="text-xs font-semibold text-muted-foreground">Columns — width in pixels, blank for automatic</legend>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {order.map((id, index) => {
              const column = byId.get(id)!;
              const shown = !draft.hidden.includes(id);
              return (
                <li key={id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={shown}
                    disabled={column.required}
                    aria-label={`Show ${column.label}`}
                    title={column.required ? `${column.label} is always shown` : undefined}
                    onChange={() => setDraft({ ...draft, hidden: shown ? [...draft.hidden, id] : draft.hidden.filter((h) => h !== id) })}
                  />
                  <span className="min-w-0 flex-1 truncate">{column.label}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={MIN_COLUMN_WIDTH}
                    max={MAX_COLUMN_WIDTH}
                    step={10}
                    placeholder={column.width ? String(column.width) : "auto"}
                    aria-label={`${column.label} width in pixels`}
                    className="h-7 w-16 rounded-md border border-border bg-background px-1.5 text-xs tabular-nums"
                    value={draft.widths[id] ?? ""}
                    onChange={(e) => {
                      const widths = { ...draft.widths };
                      if (e.target.value === "") delete widths[id];
                      else widths[id] = Number(e.target.value);
                      setDraft({ ...draft, widths });
                    }}
                  />
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${column.label} up`} title={`Move ${column.label} up`} disabled={index === 0} onClick={() => move(id, -1)}>
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Move ${column.label} down`} title={`Move ${column.label} down`} disabled={index === order.length - 1} onClick={() => move(id, 1)}>
                    <ArrowDown className="size-3.5" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </fieldset>
        <div className="flex justify-between gap-2 border-t border-border pt-3">
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => save(null)}>
            Reset
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={() => save(draft)}>
            {pending ? "Saving…" : "Save layout"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* --------------------------------------------------------------- selection */

type SelectionContext = {
  sel: GridSelection;
  setSel: (next: GridSelection) => void;
  pageIds: string[];
};
const Ctx = createContext<SelectionContext | null>(null);
const useSelection = () => useContext(Ctx);

/**
 * Holds what is ticked on THIS page of the list. The grid remounts it whenever
 * the search, sort or page changes, so a tick never silently carries over to
 * rows the person can no longer see.
 */
export function GridSelectionProvider({
  pageIds,
  total,
  q,
  noun,
  preview,
  children,
}: {
  pageIds: string[];
  total: number;
  q: string;
  noun: { one: string; many: string };
  preview: (request: SelectionRequest) => Promise<ActionResult>;
  children: ReactNode;
}) {
  const [sel, setSelState] = useState<GridSelection>(EMPTY_SELECTION);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, start] = useTransition();
  const setSel = (next: GridSelection) => {
    setSelState(next);
    setResult(null);
  };
  const count = selectedCount(sel, total);
  const pageAllOn = pageIds.length > 0 && pageIds.every((id) => sel.ids.includes(id));
  const name = (n: number) => `${n.toLocaleString("en")} ${n === 1 ? noun.one : noun.many}`;

  const runPreview = () =>
    start(async () => {
      setResult(await preview(sel.allMatching ? { mode: "all", q, shownTotal: total } : { mode: "ids", ids: sel.ids }));
    });

  return (
    <Ctx.Provider value={{ sel, setSel, pageIds }}>
      {count > 0 && (
        <div role="region" aria-label="Selection" className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="font-medium">
            {sel.allMatching ? `All ${name(total)} matching this list are selected` : `${name(count)} selected on this page`}
          </span>
          {!sel.allMatching && pageAllOn && total > pageIds.length && (
            <Button type="button" variant="link" size="sm" onClick={() => setSel(selectAllMatching())}>
              Select all {name(total)}
            </Button>
          )}
          <span className="ml-auto flex gap-2">
            <Button type="button" variant="outline" size="sm" disabled={pending} onClick={runPreview}>
              {pending ? "Checking…" : "Preview"}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSel(EMPTY_SELECTION)}>
              Clear
            </Button>
          </span>
          <p aria-live="polite" className={cn("w-full text-xs", result?.error ? "text-destructive" : "text-muted-foreground")}>
            {result ? result.error ?? result.success : "Preview re-checks every selected row against your access. No bulk actions run from here yet."}
          </p>
        </div>
      )}
      {children}
    </Ctx.Provider>
  );
}

export function GridPageCheckbox() {
  const ctx = useSelection();
  const ref = useRef<HTMLInputElement>(null);
  const some = !!ctx && ctx.pageIds.some((id) => ctx.sel.ids.includes(id));
  const all = !!ctx && (ctx.sel.allMatching || (ctx.pageIds.length > 0 && ctx.pageIds.every((id) => ctx.sel.ids.includes(id))));
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some && !all;
  }, [some, all]);
  if (!ctx) return null;
  return (
    <input
      ref={ref}
      type="checkbox"
      className="size-4 accent-primary"
      aria-label="Select every row on this page"
      checked={all}
      disabled={ctx.sel.allMatching}
      onChange={() => ctx.setSel(togglePage(ctx.sel, ctx.pageIds))}
    />
  );
}

export function GridRowCheckbox({ id, label }: { id: string; label: string }) {
  const ctx = useSelection();
  if (!ctx) return null;
  return (
    <input
      type="checkbox"
      className="size-4 accent-primary"
      aria-label={`Select ${label}`}
      checked={ctx.sel.allMatching || ctx.sel.ids.includes(id)}
      disabled={ctx.sel.allMatching}
      onChange={() => ctx.setSel(toggleRow(ctx.sel, id))}
    />
  );
}
