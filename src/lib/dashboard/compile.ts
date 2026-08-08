import { cache } from "react";
import {
  addDays,
  addMonths,
  addYears,
  startOfDay,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import { LIMITS, type CardMetric, type CardQuery, type QueryFilter } from "./config";
import {
  OPERATORS_FOR_TYPE,
  canUseField,
  canUseSource,
  fieldOf,
  sourceById,
  type PeriodId,
  type SourceDef,
  type SourceField,
  type SourceId,
} from "./sources";

/**
 * Turning a saved card config into a Prisma query.
 *
 * sources.ts closes the VOCABULARY — a config may only name things written out
 * by hand in that catalogue. This file is the other half: given a name that
 * survived the catalogue, it decides what query is actually issued, and it is
 * where the vocabulary stops being a list of strings and starts being rows on
 * somebody's screen. Everything below exists to make one sentence true: a card
 * cannot show a row, a column or a total that the person looking at it could not
 * already reach through the record pages.
 *
 * ── THE SHAPE, AND WHY ──────────────────────────────────────────────────────
 *
 * The top half of the file is pure: `compileWhere`, `compileOrderBy`,
 * `compileSelect`, `compileTake` and `periodRange` take plain values and return
 * plain objects, with no Prisma import and no database. That is deliberate and
 * it is the same discipline sources.ts and registry.ts follow, for the same
 * reason — the rules most worth testing are the ones a leak would come from, and
 * a module that constructs a PrismaClient cannot be imported by `node --test`.
 * The `run*` functions at the bottom reach the client through a DYNAMIC import,
 * so the unit suite can exercise every guard here without a database while the
 * query path still pulls in the `server-only` chain (data.ts) at call time — and
 * still refuses to bundle into a client component, because the bundler resolves
 * a dynamic import just as it resolves a static one.
 *
 * ── WHAT AN UNCOMPILABLE FRAGMENT DOES ──────────────────────────────────────
 *
 * A config can name a field that has since been removed, a field the viewer is
 * not trusted with, an operator that does not apply to the type, or a value of
 * the wrong shape. There are two possible answers and only one of them is safe.
 *
 * A FILTER that cannot be compiled is dropped, and dropping a filter WIDENS the
 * result — "value greater than a million" removed from a card leaves "every
 * lead", which is the precise moment a narrow card becomes a broad one without
 * anybody touching it. So a filter this file cannot honour faithfully makes the
 * whole query match nothing (`IMPOSSIBLE` below). An empty card is a visible,
 * self-correcting failure; a card that quietly shows more than it was built to
 * show is not. The same rule covers the period window, which is a filter by
 * another name.
 *
 * A SORT or a COLUMN that cannot be compiled is simply dropped, because neither
 * changes WHICH rows come back — the sort falls back to the source's default and
 * an unknown column just does not render. Widening is the failure that matters,
 * so the two are treated differently on purpose.
 *
 * ── MONEY IS CENTS. ONCE, HERE ──────────────────────────────────────────────
 *
 * Every `money` field is stored as integer cents, and the editor collects rands
 * because that is what a person types. The multiplication by 100 happens in
 * `coerceValue` and NOWHERE else, so "greater than 5000" filters on 500000 cents
 * rather than on five thousand cents — an off-by-a-hundred that would silently
 * return the whole pipeline. Totals come back OUT of `runMetricQuery` in cents
 * too; formatting them is the renderer's job.
 */

/* ── the viewer, as a plain value ─────────────────────────────────── */

/**
 * Everything the compiler needs to know about who is asking, with no promises
 * and no request context, so a test can construct one.
 *
 * `accessibleIds` carries the null/empty distinction the whole row scope hangs
 * on: `null` means UNRESTRICTED (owner, or a `view_all` grant) and must emit no
 * id predicate at all, while an EMPTY array means the viewer may see nothing of
 * this type and must emit `id: { in: [] }`. Confusing the two either opens every
 * row or closes every row, and only one of those is noticed.
 */
export type ScopeContext = {
  userId: string;
  accessibleIds: string[] | null;
  permissions: ReadonlySet<string>;
  /**
   * May this viewer use this source AT ALL — `canUseSource`, which is module AND
   * permission.
   *
   * A separate flag rather than something inferred from the two fields above,
   * because neither of them can express it. `accessibleIds` answers "which rows",
   * and for the four sources with a `view_all` grant the answer is `null`,
   * meaning unrestricted — indistinguishable from a viewer who should not reach
   * the source at all. `permissions` is consulted per FIELD, not per source.
   *
   * The gate this closes was open: `canUseSource` had no callers anywhere on the
   * read path. It was wired only to `usableSources`, which fills the editor's
   * dropdowns — so the module half of the rule its own catalogue states ("module
   * state is a TENANT entitlement no role overrides, permission is WHO, and both
   * must pass") was enforced in the UI and nowhere else. A card built while a
   * module was enabled kept rendering after the tenant lost it.
   *
   * The permission half happened to hold anyway, by a route it was not designed
   * for: `getAccessible*Ids` returns `[]` rather than `null` when the viewer
   * holds neither grant, so those cards came back empty. That is why this never
   * showed up as a leak — except on `activities`, the one source scoped by an
   * ownership COLUMN, where nothing consulted the source's permission list and a
   * viewer holding neither `activities.view` nor `activities.manage` still got
   * their own diary.
   */
  usable: boolean;
};

export type CompiledRows = { rows: Record<string, unknown>[]; total: number };

export type GroupedRow = { key: string; label: string; value: number };

/**
 * Grouped results, with a flag saying whether they describe every matching row.
 *
 * It is an array with one extra property rather than a wrapper object so it
 * still satisfies the plain `GroupedRow[]` a caller expects; a renderer that
 * ignores `truncated` gets exactly what it asked for. A chart that silently
 * describes the first slice of the data is worse than one labelled "based on
 * the first N records", which is the only reason the flag exists.
 */
export type GroupedRows = GroupedRow[] & { truncated: boolean };

/* ── caps ─────────────────────────────────────────────────────────── */

/**
 * How many rows a relation-hop grouping may scan.
 *
 * Prisma cannot `groupBy` a field that lives across a relation (`stage.name`),
 * so those are counted in TypeScript over a `select`. That is an unbounded scan
 * unless something bounds it, and the home page is not the place to pull a
 * hundred thousand rows into memory. Beyond this cap the result is TRUNCATED
 * rather than wrong-but-confident — see GroupedRows.
 */
export const GROUP_SCAN_CAP = 5000;

/** Slices in one chart. Past this, a chart is a table with worse labels. */
export const MAX_GROUPS = 24;

/** Values one `in` filter may carry. A config is user input; it needs a bound. */
export const MAX_IN_VALUES = 50;

/**
 * The predicate that matches nothing. `id` exists on every source's model, and
 * an empty `in` list is the one thing guaranteed to select no row.
 */
const IMPOSSIBLE: Record<string, unknown> = { id: { in: [] as string[] } };

/* ── paths ────────────────────────────────────────────────────────── */

/**
 * Split a catalogue path into its segments, refusing anything deeper than one
 * relation hop.
 *
 * ONE hop is a rule about the blast radius rather than about Prisma's
 * abilities. `contact.owner.team.name` is a join the card builder never offered
 * and nobody has reasoned about the scoping of — the accessible-id helpers scope
 * the ROOT model, and every extra hop is another model whose own permissions
 * were never consulted. Two dots therefore does not compile, and because an
 * uncompilable filter matches nothing, a hand-edited config cannot walk out
 * along a relation chain.
 */
function splitPath(path: string): string[] | null {
  const parts = path.split(".");
  if (parts.length > 2) return null;
  if (parts.some((part) => part.length === 0)) return null;
  return parts;
}

/** `stage.name` + predicate → `{ stage: { name: predicate } }`. */
function nest(path: string, predicate: unknown): Record<string, unknown> | null {
  const parts = splitPath(path);
  if (!parts) return null;
  if (parts.length === 1) return { [parts[0]]: predicate };
  return { [parts[0]]: { [parts[1]]: predicate } };
}

/* ── the allowlist gate ───────────────────────────────────────────── */

/**
 * What a field is about to be used FOR. Every use has its own rules and they do
 * not overlap: a composite name is displayable but not filterable, a relation
 * hop is groupable but not sortable, a money column is aggregatable and a date
 * column is not.
 */
export type FieldUse = "filter" | "sort" | "group" | "select" | "aggregate" | "period";

/**
 * The ONE way a config's field name becomes a query fragment.
 *
 * Every filter, sort, group-by, period field, select column and aggregate goes
 * through here, and anything it returns null for is not passed through in any
 * form. Having a single gate is the point: a second path from a config string to
 * a Prisma key is a second place to forget the permission check, and the
 * permission check is what keeps a rep from summing a pipeline value they are
 * not shown in the record list either.
 */
export function resolveField(
  source: SourceDef,
  key: string,
  ctx: ScopeContext,
  use: FieldUse,
): SourceField | null {
  const field = fieldOf(source, key);
  if (!field) return null;
  // Reuse the catalogue's own gate rather than re-testing `field.permission`
  // here, so the editor's "which fields may I offer" answer and the compiler's
  // "which fields may I emit" answer can never drift apart. `modules` is not
  // consulted by canUseField — the source's own module gate is checked before a
  // card is rendered at all.
  if (!canUseField(field, { permissions: ctx.permissions, modules: new Set<string>() })) return null;
  // A composite is several columns joined for display. It cannot answer a
  // question about any one of them, so it is select-only — see SourceField.paths.
  if (field.paths && use !== "select") return null;
  for (const path of [field.path, ...(field.paths ?? [])]) {
    if (!splitPath(path)) return null;
  }
  switch (use) {
    case "filter":
      return field.filterable === false ? null : field;
    case "sort":
      return field.sortable === false ? null : field;
    case "group":
      return field.groupable === true ? field : null;
    case "aggregate":
      return field.aggregatable === true ? field : null;
    case "period":
      return field.type === "date" ? field : null;
    case "select":
      return field;
  }
}

/* ── relative periods ─────────────────────────────────────────────── */

/**
 * A period id and a clock, into a half-open date range.
 *
 * Half-open (`gte`/`lt`) rather than inclusive on both ends because the
 * alternative is a boundary bug nobody sees: a row stamped at exactly midnight
 * lands in two windows or neither depending on which comparison was written, and
 * a dashboard is a thing people glance at rather than reconcile.
 *
 * The rolling windows are aligned to CALENDAR DAYS — "last 7 days" ends at the
 * end of today and starts at the beginning of the day six days ago — so "Today"
 * is a strict subset of "Last 7 days" and two cards sitting side by side can be
 * compared. A rolling instant ("now minus 168 hours") would make the smaller
 * card show rows the larger one omits, which reads as a bug in the data.
 *
 * Every window carries an UPPER bound as well as a lower one, because several
 * catalogue date fields are legitimately in the future (`validUntil`,
 * `deliveryScheduledFor`), and "this month" that quietly includes next year's
 * bookings is not this month.
 *
 * `null` means "all time" — no predicate at all.
 */
export function periodRange(period: PeriodId, now: Date): { gte?: Date; lt?: Date } | null {
  const dayStart = startOfDay(now);
  const tomorrow = addDays(dayStart, 1);
  switch (period) {
    case "all":
      return null;
    case "today":
      return { gte: dayStart, lt: tomorrow };
    case "7d":
      return { gte: startOfDay(subDays(now, 6)), lt: tomorrow };
    case "30d":
      return { gte: startOfDay(subDays(now, 29)), lt: tomorrow };
    case "90d":
      return { gte: startOfDay(subDays(now, 89)), lt: tomorrow };
    case "month":
      return { gte: startOfMonth(now), lt: startOfMonth(addMonths(now, 1)) };
    case "last_month":
      return { gte: startOfMonth(subMonths(now, 1)), lt: startOfMonth(now) };
    case "year":
      return { gte: startOfYear(now), lt: startOfYear(addYears(now, 1)) };
    /*
     * The stale windows. Open-ENDED on the early side on purpose: "older than 30
     * days" means everything from the beginning of time up to that cut, not the
     * month before it. A lead untouched for two years is more stale than one
     * untouched for five weeks, not less, and a bounded window would silently
     * drop exactly the rows the card exists to surface.
     *
     * `lt` only, so these compose with the half-open convention every window
     * above uses and a row on the boundary belongs to exactly one of them.
     */
    case "older_7d":
      return { lt: startOfDay(subDays(now, 6)) };
    case "older_30d":
      return { lt: startOfDay(subDays(now, 29)) };
    case "older_90d":
      return { lt: startOfDay(subDays(now, 89)) };
  }
}

/* ── values ───────────────────────────────────────────────────────── */

type Coerced = { ok: true; value: unknown } | { ok: false };
const BAD: Coerced = { ok: false };

/**
 * A config value into the type the column actually holds.
 *
 * A saved config is JSON that outlived the session that wrote it, so "the editor
 * would never send that" is not an argument. Anything that does not coerce is a
 * failure to compile, and a filter that fails to compile takes the whole query
 * with it — see the file header.
 */
function coerceValue(field: SourceField, raw: unknown): Coerced {
  switch (field.type) {
    case "money": {
      // RANDS IN, CENTS OUT. The only place this conversion happens.
      if (typeof raw !== "number" || !Number.isFinite(raw)) return BAD;
      return { ok: true, value: Math.round(raw * 100) };
    }
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) return BAD;
      return { ok: true, value: raw };
    }
    case "boolean":
      return typeof raw === "boolean" ? { ok: true, value: raw } : BAD;
    case "date": {
      if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? BAD : { ok: true, value: raw };
      if (typeof raw !== "string" && typeof raw !== "number") return BAD;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? BAD : { ok: true, value: parsed };
    }
    case "enum": {
      // A closed set stays closed. Accepting an unlisted value would let a
      // hand-edited config probe for statuses that are not in the catalogue.
      if (typeof raw !== "string") return BAD;
      const allowed = field.options?.some((option) => option.value === raw) ?? false;
      return allowed ? { ok: true, value: raw } : BAD;
    }
    case "text":
    case "user":
    case "relation":
      return typeof raw === "string" && raw.length > 0 && raw.length <= 200
        ? { ok: true, value: raw }
        : BAD;
  }
}

/* ── filters ──────────────────────────────────────────────────────── */

/**
 * One filter into one Prisma predicate, or null if it cannot be honoured.
 *
 * The operator is checked against OPERATORS_FOR_TYPE rather than against a list
 * written here, so the comparisons the editor offers and the comparisons the
 * compiler accepts are the same set by construction — a `contains` smuggled onto
 * an enum does not compile.
 */
function compileFilter(
  source: SourceDef,
  filter: QueryFilter,
  ctx: ScopeContext,
): Record<string, unknown> | null {
  const field = resolveField(source, filter.field, ctx, "filter");
  if (!field) return null;
  if (!OPERATORS_FOR_TYPE[field.type].includes(filter.operator)) return null;

  // Emptiness asks about the column rather than about a value, so it is the one
  // pair that needs no operand. Text columns that hold "" rather than NULL are
  // deliberately NOT treated as empty: the two are different states, and folding
  // them together here would make the filter mean something the editor did not
  // say.
  if (filter.operator === "is_empty") return nest(field.path, null);
  if (filter.operator === "is_not_empty") return nest(field.path, { not: null });

  if (filter.operator === "in") {
    if (!Array.isArray(filter.value) || filter.value.length === 0) return null;
    if (filter.value.length > MAX_IN_VALUES) return null;
    const values: unknown[] = [];
    for (const entry of filter.value) {
      const coerced = coerceValue(field, entry);
      if (!coerced.ok) return null;
      values.push(coerced.value);
    }
    return nest(field.path, { in: values });
  }

  const coerced = coerceValue(field, filter.value);
  if (!coerced.ok) return null;
  const value = coerced.value;

  switch (filter.operator) {
    case "equals":
      return nest(field.path, value);
    case "not_equals":
      return nest(field.path, { not: value });
    case "contains":
      return nest(field.path, { contains: value, mode: "insensitive" });
    case "not_contains":
      return nest(field.path, { not: { contains: value, mode: "insensitive" } });
    case "greater_than":
      return nest(field.path, { gt: value });
    case "greater_or_equal":
      return nest(field.path, { gte: value });
    case "less_than":
      return nest(field.path, { lt: value });
    case "less_or_equal":
      return nest(field.path, { lte: value });
    default:
      return null;
  }
}

/* ── row scope ────────────────────────────────────────────────────── */

/**
 * The permission that means "everyone's rows, not just yours", for a source
 * scoped by an ownership COLUMN rather than by an accessible-id helper.
 *
 * Derived from the source's own permission list rather than configured
 * separately, so a source cannot arrive with a scope gate nobody wrote down.
 * `*.view_all` is the usual spelling; `*.manage` is the fallback, which is what
 * activities use (`activities.view` sees your own diary, `activities.manage`
 * runs everybody's). If a source lists NEITHER, this returns null and the owner
 * predicate is applied unconditionally — the narrowest possible answer, because
 * a missing gate must fail closed.
 */
function viewAllPermission(source: SourceDef): string | null {
  return (
    source.permissions.find((key) => key.endsWith(".view_all")) ??
    source.permissions.find((key) => key.endsWith(".manage")) ??
    null
  );
}

/**
 * "Rows belonging to me", used by `scope: "mine"`.
 *
 * The owning column is found by TYPE — the first `user` field the viewer may
 * filter on — rather than by a hard-coded key per source, so a new source gets
 * this for free by listing its owner field. Null means the source has no user
 * column at all (vehicles), and the caller turns that into a query matching
 * nothing: a card whose author narrowed it to "mine" must not quietly come back
 * as everybody's, which is exactly how a personal card becomes a team report.
 */
function ownerPredicate(source: SourceDef, ctx: ScopeContext): Record<string, unknown> | null {
  for (const field of source.fields) {
    if (field.type !== "user") continue;
    if (!resolveField(source, field.key, ctx, "filter")) continue;
    return nest(field.path, ctx.userId);
  }
  return null;
}

/* ── the `where` ──────────────────────────────────────────────────── */

/**
 * The whole predicate for one card: row scope, soft delete, the "mine" switch,
 * the period window and the config's filters.
 *
 * Order matters only in that the first two are written directly onto the object
 * and everything else is ANDed on top. A narrowing can therefore be added but
 * never removed — nothing below can reach the id scope or the soft-delete
 * exclusion to widen it, because they are separate keys and Prisma ANDs the lot.
 */
export function compileWhere(
  source: SourceDef,
  query: CardQuery,
  ctx: ScopeContext,
): Record<string, unknown> {
  // INVARIANT, and the first one because nothing below can rescue it: a viewer
  // who may not use this source gets a query matching nothing.
  //
  // Returned outright rather than merged into `where`, because the two branches
  // below are not equivalent for the two kinds of scope. For an `ids` source an
  // empty `accessibleIds` would already close it — but for an `owner` source
  // (activities) the id list is never consulted, and the owner predicate would
  // still hand back the viewer's own rows. A single early return closes both,
  // and cannot be widened by a filter, a period or a `mine` switch, because none
  // of them run.
  if (!ctx.usable) return { ...IMPOSSIBLE };

  const where: Record<string, unknown> = {};

  // INVARIANT: soft-deleted rows are never in a card. The Trash is a screen with
  // its own permission and its own audit trail; a card that could be pointed at
  // deleted records would be a way to keep reading a record somebody deleted
  // precisely so it would stop being visible. The filtered `prisma` client adds
  // this too — this is not a reason to leave it out, because the guard that is
  // tested must be the guard in the query, and one day a caller reaches for a
  // client that does not carry the extension.
  if (source.softDelete) where.deletedAt = null;

  // INVARIANT: the row scope, always. Same scoping the record LIST pages use,
  // which is the entire point — a card must not be a way around the page.
  if (source.scope.by === "ids") {
    if (ctx.accessibleIds !== null) where.id = { in: ctx.accessibleIds };
  } else {
    const viewAll = viewAllPermission(source);
    if (!viewAll || !ctx.permissions.has(viewAll)) {
      const owned = nest(source.scope.field, ctx.userId);
      // A scope column that does not compile leaves the source unscopable, so
      // the query matches nothing rather than everything.
      Object.assign(where, owned ?? IMPOSSIBLE);
    }
  }

  const and: Record<string, unknown>[] = [];

  // INVARIANT: `mine` NARROWS. It is ANDed on top of the row scope above and can
  // never replace or widen it — a rep who may see only their own leads gets
  // their own leads under either setting.
  if (query.scope === "mine") and.push(ownerPredicate(source, ctx) ?? IMPOSSIBLE);

  // The period is a filter written in a friendlier vocabulary, and it fails the
  // same way: a window that cannot be compiled matches nothing rather than
  // silently becoming "all time".
  if (query.period !== "all") {
    const field = resolveField(source, query.periodField ?? source.dateField, ctx, "period");
    const range = field ? periodRange(query.period as PeriodId, new Date()) : null;
    const predicate = field && range ? nest(field.path, range) : null;
    and.push(predicate ?? IMPOSSIBLE);
  }

  for (const filter of query.filters.slice(0, LIMITS.filtersPerCard)) {
    and.push(compileFilter(source, filter, ctx) ?? IMPOSSIBLE);
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/* ── ordering, columns, size ──────────────────────────────────────── */

/**
 * The sort, falling back to the source's default and then to newest-first by id.
 *
 * Falling back rather than refusing is safe here in a way it is not for filters:
 * a sort decides the ORDER of rows the viewer may already see, so losing it
 * costs nothing but tidiness. The final `id` fallback exists so a catalogue
 * whose default sort names a retired field still produces a stable order rather
 * than an unordered `take`, which is how a list card starts showing a different
 * eight rows on every refresh.
 */
export function compileOrderBy(source: SourceDef, query: CardQuery): Record<string, unknown> {
  // No permissions at all, which is the strict reading and the right one:
  // ordering by a gated column ranks the rows by a number the viewer is not
  // shown, and "the top eight by deal value" discloses the deal values in every
  // way that matters. A gated sort field therefore fails to resolve and the card
  // falls back to the source's default order.
  // `usable: true` because this decides the ORDER of rows, never which rows:
  // whether the viewer may reach the source at all is settled by compileWhere,
  // and a refused card has no rows for this to order.
  const ctx: ScopeContext = { userId: "", accessibleIds: null, permissions: NO_PERMISSIONS, usable: true };
  const requested = query.sort ? resolveField(source, query.sort.field, ctx, "sort") : null;
  if (requested && query.sort) {
    const order = nest(requested.path, query.sort.dir);
    if (order) return order;
  }
  const fallback = resolveField(source, source.defaultSort.field, ctx, "sort");
  const order = fallback ? nest(fallback.path, source.defaultSort.dir) : null;
  return order ?? { id: "desc" };
}

/** Holds nothing, so every gated field fails to resolve. */
const NO_PERMISSIONS: ReadonlySet<string> = new Set<string>();

/**
 * The `select` for a list card.
 *
 * `id` is always included because every row links to its record; the href
 * template in the catalogue substitutes it. Columns that do not resolve are
 * DROPPED rather than passed through — an unknown key reaching Prisma is either
 * an error or, worse, a real column nobody meant to publish. Dropping cannot
 * widen the row set, so unlike a filter it needs no impossible-predicate
 * treatment.
 *
 * `ctx` is required rather than optional on purpose. A permission-gated column
 * must never be selected, and an optional guard is a guard that gets forgotten
 * at one of the call sites.
 */
export function compileSelect(
  source: SourceDef,
  columnKeys: string[],
  ctx: ScopeContext,
): Record<string, unknown> {
  const select: Record<string, unknown> = { id: true };
  for (const key of columnKeys.slice(0, LIMITS.columnsPerCard)) {
    const field = resolveField(source, key, ctx, "select");
    if (!field) continue;
    // A composite selects all of its parts; the renderer joins them.
    for (const path of [field.path, ...(field.paths ?? [])]) addPath(select, path);
  }
  return select;
}

function addPath(select: Record<string, unknown>, path: string): void {
  const parts = splitPath(path);
  if (!parts) return;
  if (parts.length === 1) {
    select[parts[0]] = true;
    return;
  }
  const [relation, column] = parts;
  const existing = select[relation] as { select: Record<string, unknown> } | undefined;
  const inner = existing?.select ?? {};
  inner[column] = true;
  select[relation] = { select: inner };
}

/**
 * How many rows a list card may fetch, whatever the config says.
 *
 * The parser caps this too, but a config row can predate the cap and a `run*`
 * caller can hand-build a query object, so the clamp lives at the query itself
 * rather than only at the door.
 */
export function compileTake(query: CardQuery): number {
  const requested = Number.isFinite(query.limit) ? Math.floor(query.limit) : 1;
  return Math.min(Math.max(requested, 1), LIMITS.listRows);
}

/**
 * The parts of one displayed cell, in catalogue order, read out of a row that
 * `compileSelect` produced.
 *
 * Exported so the renderer does not re-implement path walking and, more to the
 * point, does not re-implement the permission check: a field this viewer may not
 * see yields nothing here even if a row somehow carries it.
 */
export function cellValues(
  source: SourceDef,
  key: string,
  row: Record<string, unknown>,
  ctx: ScopeContext,
): unknown[] {
  const field = resolveField(source, key, ctx, "select");
  if (!field) return [];
  return [field.path, ...(field.paths ?? [])].map((path) => readPath(row, path));
}

function readPath(row: Record<string, unknown>, path: string): unknown {
  const parts = splitPath(path);
  if (!parts) return undefined;
  if (parts.length === 1) return row[parts[0]];
  const nested = row[parts[0]];
  if (!nested || typeof nested !== "object") return undefined;
  return (nested as Record<string, unknown>)[parts[1]];
}

/* ── the binding to actual models ─────────────────────────────────── */

/**
 * Source id → Prisma model. This is the join sources.ts refers to when it says
 * the binding from a catalogue `path` to an actual query lives here; a source
 * missing from this map has no way to run and is caught by a guard rather than
 * at render time.
 */
export const MODEL_BY_SOURCE: Record<SourceId, string> = {
  leads: "lead",
  quotes: "quote",
  activities: "activity",
  contacts: "contact",
  jobcards: "jobCard",
  vehicles: "vehicle",
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Delegate = {
  findMany(args: any): Promise<Record<string, unknown>[]>;
  count(args: any): Promise<number>;
  aggregate(args: any): Promise<Record<string, Record<string, number | null>>>;
  groupBy(args: any): Promise<Record<string, unknown>[]>;
};

/**
 * The extended `prisma` client, never `basePrisma` and never raw SQL.
 *
 * The extension is what applies the soft-delete filter and, once tenant
 * enforcement is live, the RLS session scope; `basePrisma` deliberately bypasses
 * both and exists for the trash and restore paths. A card compiled from user
 * input is the last thing that should be running on the bypass client. Raw SQL
 * is absent for the reason sources.ts gives at length: the vocabulary must be
 * closed, and a string that reaches the database is not.
 */
async function delegateFor(source: SourceDef): Promise<Delegate> {
  const { prisma } = await import("@/lib/db");
  const client = prisma as unknown as Record<string, Delegate>;
  return client[MODEL_BY_SOURCE[source.id]];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Contacts have no scope helper in data.ts, so the permissions helper is called
 * directly and memoised per REQUEST here — the same treatment leads, quotes,
 * vehicles and job cards get there, so a dashboard with four contact cards still
 * costs one accessible-id lookup rather than four.
 */
const contactScope = cache(async (): Promise<string[] | null> => {
  const [{ getAccessibleContactIds }, { dashboardViewer }] = await Promise.all([
    import("@/lib/permissions"),
    import("./data"),
  ]);
  return getAccessibleContactIds((await dashboardViewer()).user);
});

/**
 * Read an id list back out of one of data.ts's `where` fragments.
 *
 * Reading it back rather than calling the accessible-id helper again keeps ONE
 * place where the null-versus-empty decision is made — the shared, memoised
 * helper — and keeps the dashboard's card queries on exactly the same scope the
 * rest of the page already resolved. An absent `id` key is the unrestricted
 * case.
 */
function idsFromScope(fragment: Record<string, unknown>): string[] | null {
  const id = fragment.id as { in?: string[] } | undefined;
  return id && Array.isArray(id.in) ? id.in : null;
}

/**
 * Resolve the asking user's scope for one source. Every `run*` entry point goes
 * through here; there is no way to hand one of them a context for somebody else,
 * because the user comes from `dashboardViewer()` — the session — and never from
 * an argument.
 */
export async function scopeContext(source: SourceDef): Promise<ScopeContext> {
  const data = await import("./data");
  const { user, access } = await data.dashboardViewer();

  // THE SOURCE GATE, before any scope is resolved.
  //
  // `access` already carries both halves — dashboardViewer() resolves modules
  // alongside permissions — so this asks the catalogue's own question rather
  // than re-deriving it here.
  //
  // Denied returns a context that is closed three ways over, not one: `usable`
  // stops compileWhere at its first line, `accessibleIds: []` closes the id
  // scope even if some future caller builds a `where` without going through
  // compileWhere, and NO_PERMISSIONS makes every gated column fail to resolve so
  // a refused source cannot leak a value through compileSelect or an aggregate.
  // Any one of the three suffices; a gate worth adding is worth not having to
  // re-derive whether it still holds after the next refactor.
  if (!canUseSource(source, access)) {
    return { userId: user.id, accessibleIds: [], permissions: NO_PERMISSIONS, usable: false };
  }

  let accessibleIds: string[] | null = null;
  if (source.scope.by === "ids") {
    switch (source.scope.helper) {
      case "lead":
        accessibleIds = idsFromScope(await data.leadWhere());
        break;
      case "quote":
        accessibleIds = idsFromScope(await data.quoteWhere());
        break;
      case "vehicle":
        accessibleIds = idsFromScope(await data.vehicleWhere());
        break;
      case "jobcard":
        accessibleIds = idsFromScope(await data.jobCardWhere());
        break;
      case "contact":
        accessibleIds = await contactScope();
        break;
    }
  }
  return { userId: user.id, accessibleIds, permissions: access.permissions, usable: true };
}

/* ── running ──────────────────────────────────────────────────────── */

/**
 * A card naming a source that no longer exists gets nothing, rather than an
 * exception on the home page — the one screen a user cannot route around.
 */
const NO_ROWS: CompiledRows = { rows: [], total: 0 };

function emptyGroups(truncated = false): GroupedRows {
  return Object.assign([] as GroupedRow[], { truncated });
}

/** The rows and the unclamped matching total for a list card. */
export async function runListQuery(query: CardQuery, columns: string[]): Promise<CompiledRows> {
  const source = sourceById(query.source);
  if (!source) return NO_ROWS;
  const ctx = await scopeContext(source);
  const where = compileWhere(source, query, ctx);
  const model = await delegateFor(source);
  const [rows, total] = await Promise.all([
    model.findMany({
      where,
      select: compileSelect(source, columns, ctx),
      orderBy: compileOrderBy(source, query),
      take: compileTake(query),
    }),
    // Counted with the SAME where, so "showing 8 of 231" is 231 rows this viewer
    // may see rather than 231 rows that exist.
    model.count({ where }),
  ]);
  return { rows, total };
}

/**
 * One number for a stat or a gauge. Money comes back in CENTS; the renderer
 * formats it.
 *
 * A metric that cannot be compiled returns 0 rather than throwing or falling
 * back to a count: 0 discloses nothing, and a stat card silently swapping one
 * question for another is worse than a card reading zero.
 */
export async function runMetricQuery(query: CardQuery, metric: CardMetric): Promise<number> {
  const source = sourceById(query.source);
  if (!source) return 0;
  const ctx = await scopeContext(source);
  const where = compileWhere(source, query, ctx);
  const model = await delegateFor(source);
  if (metric.fn === "count") return model.count({ where });

  const field = metric.field ? resolveField(source, metric.field, ctx, "aggregate") : null;
  if (!field) return 0;
  const parts = splitPath(field.path);
  // Aggregates are scalar-only: Prisma cannot sum across a relation hop, and
  // every aggregatable field in the catalogue is a column on the model itself.
  if (!parts || parts.length !== 1) return 0;
  const key = `_${metric.fn}` as const;
  const result = await model.aggregate({ where, [key]: { [parts[0]]: true } });
  return result?.[key]?.[parts[0]] ?? 0;
}

/**
 * A chart's slices.
 *
 * Scalar group fields are grouped in the database. A relation hop cannot be —
 * Prisma has no `groupBy` across a relation — so those are counted in
 * TypeScript over a capped `select`, and the cap is surfaced as `truncated`
 * rather than hidden. See GROUP_SCAN_CAP.
 */
export async function runGroupedQuery(
  query: CardQuery,
  groupBy: string,
  metric: CardMetric,
): Promise<GroupedRows> {
  const source = sourceById(query.source);
  if (!source) return emptyGroups();
  const ctx = await scopeContext(source);
  const field = resolveField(source, groupBy, ctx, "group");
  if (!field) return emptyGroups();
  const groupParts = splitPath(field.path);
  if (!groupParts) return emptyGroups();

  // `count` needs no field; anything else needs an aggregatable scalar one, and
  // an un-aggregatable metric yields no chart rather than quietly becoming a
  // count — a bar labelled "total value" that is really a headcount is a lie the
  // viewer has no way to spot. Null here means, and only ever means, `count`.
  let valueColumn: string | null = null;
  if (metric.fn !== "count") {
    const valueField = metric.field ? resolveField(source, metric.field, ctx, "aggregate") : null;
    const parts = valueField ? splitPath(valueField.path) : null;
    if (!parts || parts.length !== 1) return emptyGroups();
    valueColumn = parts[0];
  }

  const where = compileWhere(source, query, ctx);
  const model = await delegateFor(source);

  if (groupParts.length === 1) {
    const column = groupParts[0];
    const aggregate = `_${metric.fn}`;
    const args: Record<string, unknown> = { by: [column], where };
    if (valueColumn) args[aggregate] = { [valueColumn]: true };
    else args._count = { _all: true };
    const rows = await model.groupBy(args);
    return finish(
      rows.map((row) => {
        const raw = row[column];
        const bucket = valueColumn
          ? ((row[aggregate] as Record<string, number | null> | undefined)?.[valueColumn] ?? 0)
          : ((row._count as { _all?: number } | undefined)?._all ?? 0);
        return { key: keyOf(raw), label: labelOf(field, raw), value: bucket };
      }),
      false,
    );
  }

  const [relation, column] = groupParts;
  const select: Record<string, unknown> = { [relation]: { select: { [column]: true } } };
  if (valueColumn) select[valueColumn] = true;
  // One more than the cap, so hitting it is DETECTABLE rather than a coincidence
  // that looks like a complete answer.
  const rows = await model.findMany({ where, select, take: GROUP_SCAN_CAP + 1 });
  const truncated = rows.length > GROUP_SCAN_CAP;
  const scanned = truncated ? rows.slice(0, GROUP_SCAN_CAP) : rows;

  // The same five aggregates the database would have applied, done by hand.
  // `sum` and `count` are the obvious ones; avg/min/max are here because taking
  // the sum for all of them — the shortcut that is easy to write — would draw a
  // chart titled "average deal size" out of totals, and nothing about the
  // picture would look wrong.
  const buckets = new Map<string, { label: string; count: number; sum: number; min: number; max: number }>();
  for (const row of scanned) {
    const nested = row[relation] as Record<string, unknown> | null | undefined;
    const raw = nested ? nested[column] : null;
    const key = keyOf(raw);
    const bucket = buckets.get(key) ?? {
      label: labelOf(field, raw),
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: Number.NEGATIVE_INFINITY,
    };
    const value = valueColumn ? numberAt(row, valueColumn) : 0;
    bucket.count += 1;
    bucket.sum += value;
    bucket.min = Math.min(bucket.min, value);
    bucket.max = Math.max(bucket.max, value);
    buckets.set(key, bucket);
  }
  const rowsOut = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: bucket.label,
    value: reduceBucket(metric.fn, bucket),
  }));
  return finish(rowsOut, truncated);
}

function reduceBucket(
  fn: CardMetric["fn"],
  bucket: { count: number; sum: number; min: number; max: number },
): number {
  switch (fn) {
    case "count":
      return bucket.count;
    case "sum":
      return bucket.sum;
    case "avg":
      return bucket.count === 0 ? 0 : bucket.sum / bucket.count;
    case "min":
      return Number.isFinite(bucket.min) ? bucket.min : 0;
    case "max":
      return Number.isFinite(bucket.max) ? bucket.max : 0;
  }
}

function numberAt(row: Record<string, unknown>, column: string): number {
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Sort the slices largest first and cap how many a chart may carry. Dropping the
 * tail sets `truncated` for the same reason the scan cap does — the chart no
 * longer describes every matching row, and it must be able to say so.
 */
function finish(rows: GroupedRow[], truncated: boolean): GroupedRows {
  const sorted = rows.sort((a, b) => b.value - a.value);
  const capped = sorted.slice(0, MAX_GROUPS);
  return Object.assign(capped, { truncated: truncated || sorted.length > MAX_GROUPS });
}

function keyOf(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (raw instanceof Date) return raw.toISOString();
  return String(raw);
}

function labelOf(field: SourceField, raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "None";
  if (field.type === "boolean") return raw ? "Yes" : "No";
  if (field.type === "enum") {
    const option = field.options?.find((entry) => entry.value === raw);
    return option?.label ?? String(raw);
  }
  return String(raw);
}
