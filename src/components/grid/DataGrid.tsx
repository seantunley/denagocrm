import Link from "next/link";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown } from "lucide-react";
import {
  MobileDataCard,
  MobileDataField,
  MobileDataFields,
  MobileDataHeader,
  MobileDataList,
  ResponsiveDataView,
  ResponsiveEntityTable,
} from "@/components/responsive-patterns";
import type { ActionResult } from "@/lib/actionResultTypes";
import { pageHref, type ListSearchParams } from "@/lib/listPaging";
import {
  columnWidth,
  sortHref,
  visibleColumns,
  type GridColumnDef,
  type GridPrefs,
  type GridSort,
  type SelectionRequest,
} from "@/lib/grid/grid";
import { cn } from "@/lib/utils";
import { GridPageCheckbox, GridRowCheckbox, GridSelectionProvider, GridSettings } from "./GridClient";

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;

/**
 * A configurable list (W2-04). The page has already scoped, filtered, sorted and
 * paged the rows on the server; this only draws them — in the person's column
 * order, widths and density, with sort links in the headers and, on a phone,
 * as labelled cards instead of a table to scroll sideways.
 *
 * A server component: cells are rendered here from the page's own functions.
 * Only the layout menu and the tick boxes run in the browser.
 */
export function DataGrid<Row>({
  gridId,
  path,
  params,
  columns,
  cells,
  rows,
  rowId,
  rowHref,
  rowLabel,
  wrapRow,
  prefs,
  sort,
  total,
  noun,
  preview,
}: {
  gridId: string;
  path: string;
  /** The page's current search params — kept by every sort link. */
  params: ListSearchParams;
  /** The columns this viewer can have (module-gated ones already removed). */
  columns: readonly GridColumnDef[];
  cells: Record<string, (row: Row) => ReactNode>;
  rows: Row[];
  rowId: (row: Row) => string;
  rowHref: (row: Row) => string;
  rowLabel: (row: Row) => string;
  /** E.g. the right-click record menu around each row. */
  wrapRow?: (row: Row, tr: ReactElement) => ReactNode;
  prefs: GridPrefs;
  sort: GridSort;
  total: number;
  noun: { one: string; many: string };
  /** Server-side re-check of a selection. Omit and the list has no tick boxes. */
  preview?: (request: SelectionRequest) => Promise<ActionResult>;
}) {
  const shown = visibleColumns(prefs, columns);
  const compact = prefs.density === "compact";
  const cellPad = compact ? "px-3 py-1.5" : "px-4 py-3.5";
  const primary = shown.find((c) => c.mobile === "primary") ?? shown[0];
  const mobileFields = shown.filter((c) => c.mobile === "field");
  const q = typeof params.q === "string" ? params.q : "";

  const mobile = (
    <MobileDataList>
      {rows.map((row) => (
        <MobileDataCard key={rowId(row)}>
          <MobileDataHeader
            title={cells[primary.id]?.(row)}
            aside={
              <Link href={rowHref(row)} aria-label={`Open ${rowLabel(row)}`} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <ArrowRight className="size-4" />
              </Link>
            }
          />
          {mobileFields.length > 0 && (
            <MobileDataFields>
              {mobileFields.map((c) => (
                <MobileDataField key={c.id} label={c.label}>{cells[c.id]?.(row)}</MobileDataField>
              ))}
            </MobileDataFields>
          )}
        </MobileDataCard>
      ))}
    </MobileDataList>
  );

  const desktop = (
    // Its own scroll box, so the sticky header stays in view while the rows scroll.
    <ResponsiveEntityTable className="max-h-[calc(100dvh-13rem)] overflow-auto rounded-2xl shadow-sm">
      <table className="w-full table-fixed text-sm">
        <colgroup>
          {preview && <col style={{ width: 44 }} />}
          {shown.map((c) => {
            const width = columnWidth(prefs, c);
            return <col key={c.id} style={width ? { width } : undefined} />;
          })}
          <col style={{ width: 44 }} />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-card text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground shadow-[inset_0_-1px_0_var(--border)]">
          <tr>
            {preview && (
              <th className="pl-4" scope="col">
                <GridPageCheckbox />
              </th>
            )}
            {shown.map((c) => {
              const active = sort.column === c.id;
              const Icon = active ? (sort.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <th
                  key={c.id}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                  className={cn(compact ? "px-3 py-2" : "px-4 py-3", ALIGN[c.align ?? "left"])}
                >
                  {c.sortable ? (
                    <Link
                      href={sortHref(path, params, c.id, sort)}
                      className={cn("inline-flex items-center gap-1 hover:text-foreground", active && "text-foreground")}
                      title={`Sort by ${c.label}`}
                    >
                      {c.label}
                      <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
                    </Link>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
            <th scope="col"><span className="sr-only">Open</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {rows.map((row) => {
            const id = rowId(row);
            const href = rowHref(row);
            const tr = (
              <tr key={id} tabIndex={0} data-nav-row="" data-nav-href={href} className="group transition-colors hover:bg-white/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
                {preview && (
                  <td className="pl-4">
                    <GridRowCheckbox id={id} label={rowLabel(row)} />
                  </td>
                )}
                {shown.map((c) => (
                  <td key={c.id} className={cn("min-w-0 overflow-hidden", cellPad, ALIGN[c.align ?? "left"])}>
                    {cells[c.id]?.(row)}
                  </td>
                ))}
                <td className="pr-4">
                  <Link href={href} aria-label={`Open ${rowLabel(row)}`} title={`Open ${rowLabel(row)}`} className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-accent hover:text-foreground group-hover:opacity-100 focus:opacity-100">
                    <ArrowRight className="size-3.5" />
                  </Link>
                </td>
              </tr>
            );
            return wrapRow ? <Fragment key={id}>{wrapRow(row, tr)}</Fragment> : tr;
          })}
        </tbody>
      </table>
    </ResponsiveEntityTable>
  );

  const grid = <ResponsiveDataView mobile={mobile} desktop={desktop} />;

  return (
    <div className="space-y-2">
      <div className="hidden justify-end sm:flex">
        <GridSettings gridId={gridId} columns={columns} prefs={prefs} />
      </div>
      {preview ? (
        <GridSelectionProvider
          // Remount on every search / sort / page change: ticks never carry over to rows out of view.
          key={pageHref(path, params, 1) + `#${String(params.page ?? "1")}`}
          pageIds={rows.map(rowId)}
          total={total}
          q={q}
          noun={noun}
          preview={preview}
        >
          {grid}
        </GridSelectionProvider>
      ) : (
        grid
      )}
    </div>
  );
}
