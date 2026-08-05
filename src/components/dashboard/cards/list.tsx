import Link from "next/link";
import { cn } from "@/lib/utils";
import { LIMITS, type ListCard } from "@/lib/dashboard/config";
import { sourceById, type SourceField } from "@/lib/dashboard/sources";
import { cellValues, resolveField, runListQuery, scopeContext } from "@/lib/dashboard/compile";
import { CardShell, EmptyLine, type RenderContext, type RenderedCard } from "./shell";
import { cellText, cellValue, rowHref } from "./values";
import { userNames } from "./people";

/**
 * Rows and columns — the card people actually build.
 *
 * ── WHY A GRID AND NOT A TABLE ──────────────────────────────────────────────
 *
 * A `<table>` sizes its columns from its contents, which is exactly wrong here:
 * two list cards side by side would have their columns land in different places,
 * and one long lead name would push the value column off the card. A CSS grid
 * with a declared template puts every row's columns in the same place regardless
 * of what is in them, and `truncate` handles the overflow the way every other
 * dense list in this app does.
 *
 * ── WHY THE COLUMN TEMPLATES ARE WRITTEN OUT ────────────────────────────────
 *
 * Tailwind scans source TEXT. A computed `grid-cols-[repeat(${n},1fr)]` is never
 * generated into the stylesheet, and the card silently collapses to one column —
 * the same trap DashboardGrid.tsx spells its spans out to avoid. So the six
 * possible templates are literals. The first column gets twice the width because
 * it carries the name of the thing, and a name truncated at 60px is not a name.
 */
const COLUMN_TEMPLATE: Record<1 | 2 | 3 | 4 | 5 | 6, string> = {
  1: "grid-cols-[minmax(0,1fr)]",
  2: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)]",
  3: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]",
  4: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
  5: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
  6: "grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]",
};

/** Amounts and counts are read down the column, so they are set right-aligned. */
function alignment(field: SourceField): string {
  return field.type === "money" || field.type === "number"
    ? "text-right tabular-nums"
    : "text-left";
}

export async function renderList(card: ListCard, ctx: RenderContext): Promise<RenderedCard> {
  const source = sourceById(card.query.source);
  if (!source) {
    // The parser refuses an unknown source, so reaching here means the catalogue
    // lost a source a saved config still names. Nothing to draw, and nothing to
    // say about it — the card is simply not there.
    return { node: null, signals: {} };
  }

  /*
   * The SAME scope context the query itself is compiled against, so the columns
   * this card draws and the columns it selected are decided by one answer. Two
   * answers is how a field the viewer may not see ends up with a heading above
   * an empty column, which announces the existence of the thing it is hiding.
   */
  const scope = await scopeContext(source);

  /*
   * An empty column list means "the ones this source starts with", not "no
   * columns". Resolving through `resolveField` rather than the raw catalogue is
   * what drops a column that has since been retired or that this viewer is not
   * entitled to — deal value is the case it exists for — and it costs that
   * column and nothing else.
   */
  const keys = (card.columns.length > 0 ? card.columns : [...source.defaultColumns]).slice(
    0,
    LIMITS.columnsPerCard,
  );
  const fields = keys
    .map((key) => resolveField(source, key, scope, "select"))
    .filter((field): field is SourceField => field !== null);

  if (fields.length === 0) return { node: null, signals: { count: 0, shown: 0 } };

  /*
   * People are looked up only when a person is actually on the card, and once
   * per request for every card that needs them — see ./people.ts. A caller that
   * already resolved its own names wins: an explicit map on the context is never
   * overridden.
   */
  const needsPeople = fields.some((field) => field.type === "user");
  const rowCtx: RenderContext =
    ctx.userNames || !needsPeople ? ctx : { ...ctx, userNames: await userNames() };

  const { rows, total } = await runListQuery(
    card.query,
    fields.map((f) => f.key),
  );

  const template = COLUMN_TEMPLATE[fields.length as 1 | 2 | 3 | 4 | 5 | 6];

  return {
    node: (
      <CardShell title={card.title}>
        {rows.length === 0 ? (
          <EmptyLine>No {source.noun} match.</EmptyLine>
        ) : (
          <div className="min-w-0">
            {/* Column headings only when there is more than one column: a single
                column of names labelled "Name" is a label telling you what you
                are already looking at. */}
            {fields.length > 1 && (
              <div className={cn("grid gap-x-3 border-b border-border/50 pb-1", template)}>
                {fields.map((field) => (
                  <span
                    key={field.key}
                    className={cn(
                      "truncate text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground/70",
                      alignment(field),
                    )}
                  >
                    {field.label}
                  </span>
                ))}
              </div>
            )}
            <ul className="divide-y divide-border/50">
              {rows.map((row, index) => {
                const href = rowHref(source.href, row);
                const cells = fields.map((field, column) => {
                  const parts = cellValues(source, field.key, row, scope);
                  return (
                    <span
                      key={field.key}
                      // The first column is the record, so it carries the weight;
                      // the rest are context and stay quiet.
                      className={cn(
                        "truncate text-[13px]",
                        alignment(field),
                        column === 0
                          ? "font-medium text-foreground"
                          : "text-[11px] text-muted-foreground",
                      )}
                      // The full value on hover, because the cell is truncated
                      // and a half-read customer name is worse than none.
                      title={cellText(parts, field, rowCtx)}
                    >
                      {cellValue(parts, field, rowCtx)}
                    </span>
                  );
                });
                const inner = cn("grid items-center gap-x-3 py-1.5", template);
                // `row.id` is the stable key when there is one. The index is the
                // fallback rather than the first cell's text, because two leads
                // may legitimately share a name and a duplicate React key
                // silently drops the second row.
                const key = typeof row.id === "string" ? row.id : `row-${index}`;
                return (
                  <li key={key} className="min-w-0">
                    {href ? (
                      <Link
                        href={href}
                        className={cn(inner, "transition-colors hover:text-primary")}
                      >
                        {cells}
                      </Link>
                    ) : (
                      <div className={inner}>{cells}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* How many were left off. Shown only when it is true, because a
                card that says "8 of 8" has spent a line saying nothing. */}
            {total > rows.length && (
              <p className="pt-1.5 text-[10.5px] text-muted-foreground/70">
                Showing {rows.length} of {total.toLocaleString("en-ZA")}.
              </p>
            )}
          </div>
        )}
      </CardShell>
    ),
    /*
     * `count` is how many MATCHED, `shown` is how many made it past the row
     * limit — the vocabulary in ./shell.tsx, where `count` means the same thing
     * on every card type.
     *
     * NO `total`. A list computes no aggregate, so there is nothing for that name
     * to mean here, and publishing the matched count under it — which this card
     * did until the vocabulary was settled — would make `total greater than 1000`
     * a row count on a list and an amount in rands on the stat card beside it.
     */
    signals: { count: total, shown: rows.length },
  };
}
