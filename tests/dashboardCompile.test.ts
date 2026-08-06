import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  MODEL_BY_SOURCE,
  cellValues,
  compileOrderBy,
  compileSelect,
  compileTake,
  compileWhere,
  periodRange,
  resolveField,
  type ScopeContext,
} from "../src/lib/dashboard/compile";
import { LIMITS, type CardQuery } from "../src/lib/dashboard/config";
import { PERIODS, SOURCES, sourceById, type SourceDef } from "../src/lib/dashboard/sources";

/**
 * Guards for the card compiler.
 *
 * Every card on a user-built dashboard is a query somebody WROTE DOWN and saved,
 * so the config outlives the session and the privileges that produced it. What
 * these prove is the small set of properties that stand between that and a leak:
 * that the row scope is on every query, that soft-deleted rows are never in one,
 * that the "mine" switch can only subtract, that a name the catalogue does not
 * know cannot become a broader query, and that a column the viewer is not
 * trusted with is never selected, filtered, sorted or totalled.
 *
 * They exercise the real compiler rather than a description of it. The pure half
 * of compile.ts reaches Prisma only through a dynamic import inside the `run*`
 * functions, which is what lets this file import it at all — a module that
 * constructs a PrismaClient cannot be loaded by `node --test`. The last test in
 * the file pins that arrangement, because losing it would quietly cost every
 * guard here.
 */

const root = path.join(__dirname, "..");
const source = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const leads = sourceById("leads") as SourceDef;
const quotes = sourceById("quotes") as SourceDef;
const activities = sourceById("activities") as SourceDef;
const contacts = sourceById("contacts") as SourceDef;
const vehicles = sourceById("vehicles") as SourceDef;

/** Everything the catalogue mentions, so a test opts OUT of a permission. */
const EVERY_PERMISSION: ReadonlySet<string> = new Set<string>([
  ...SOURCES.flatMap((s) => s.permissions.map((key) => key as string)),
  ...SOURCES.flatMap((s) => s.fields.flatMap((f) => (f.permission ? [f.permission as string] : []))),
]);

// `usable: true` by default so a test opts OUT of the source gate the same way
// it opts out of a permission. The gate itself is exercised in its own block
// below; every other test here is about what a PERMITTED viewer compiles.
function ctx(over: Partial<ScopeContext> = {}): ScopeContext {
  return { userId: "user-1", accessibleIds: null, permissions: EVERY_PERMISSION, usable: true, ...over };
}

function withoutPermission(key: string): ReadonlySet<string> {
  return new Set([...EVERY_PERMISSION].filter((k) => k !== key));
}

function query(over: Partial<CardQuery> = {}): CardQuery {
  return { source: "leads", filters: [], scope: "team", period: "all", limit: 8, ...over };
}

/** The predicate the compiler emits when it cannot honour something faithfully. */
const IMPOSSIBLE = { id: { in: [] as string[] } };

function andOf(where: Record<string, unknown>): Record<string, unknown>[] {
  return (where.AND as Record<string, unknown>[] | undefined) ?? [];
}

/* ── 1. the row scope is on every query ───────────────────────────── */

test("an id-scoped source carries the viewer's accessible ids", () => {
  // The failure this catches is the whole reason the compiler exists: a card
  // that counts or lists rows its viewer cannot open through the record pages.
  const where = compileWhere(leads, query(), ctx({ accessibleIds: ["a", "b"] }));
  assert.deepEqual(where.id, { in: ["a", "b"] }, "the accessible-id list must reach the where");
});

test("an EMPTY accessible-id list matches nothing, and is not mistaken for unrestricted", () => {
  // The most expensive one-character mistake available here. An empty list means
  // "this viewer may see none of these", and collapsing it to `{}` — the natural
  // thing to write when null and [] are both falsy-ish — shows them everything.
  const where = compileWhere(leads, query(), ctx({ accessibleIds: [] }));
  assert.deepEqual(where.id, { in: [] }, "an empty id list must compile to an impossible match");
});

test("a null accessible-id list emits no id predicate at all", () => {
  // The mirror of the case above: null means unrestricted (owner / view_all), so
  // emitting `id: { in: [] }` here would hand a fully privileged user an empty
  // dashboard and send someone looking for the bug in the wrong half of the app.
  const where = compileWhere(leads, query(), ctx({ accessibleIds: null }));
  assert.ok(!("id" in where), "an unrestricted viewer must not be narrowed by an id filter");
});

test("an owner-scoped source is narrowed to the viewer's own rows without the elevated grant", () => {
  // Activities have no accessible-id helper — ownership is a column — so this is
  // the only thing standing between a viewer with `activities.view` and the
  // whole company's diary.
  const scoped = compileWhere(
    activities,
    query({ source: "activities" }),
    ctx({ permissions: new Set(["activities.view"]) }),
  );
  assert.equal(scoped.assignedToId, "user-1", "an owner-scoped source must filter on the owner column");

  const elevated = compileWhere(
    activities,
    query({ source: "activities" }),
    ctx({ permissions: new Set(["activities.view", "activities.manage"]) }),
  );
  assert.ok(
    !("assignedToId" in elevated),
    "the elevated grant should lift the owner filter, or the control case proves nothing",
  );
});

test("every source is scoped one way or the other, for every query shape", () => {
  // Total rather than per-source, so a source added later cannot arrive
  // unscoped: with no privileges and no accessible ids, no source may compile a
  // where that would match a row the viewer has no claim to.
  for (const src of SOURCES) {
    const where = compileWhere(
      src,
      query({ source: src.id }),
      { userId: "user-1", accessibleIds: [], permissions: new Set<string>(), usable: true },
    );
    const scoped =
      JSON.stringify(where.id) === JSON.stringify({ in: [] }) ||
      Object.values(where).includes("user-1");
    assert.ok(scoped, `${src.id} compiled a query with no row scope`);
  }
});

/* ── 2. soft-deleted rows are never in a card ─────────────────────── */

test("a soft-deleting source always excludes deleted rows, whatever the config asks", () => {
  // A card pointed at deleted records would be a way to read the Trash without
  // holding its permission — and to keep reading a record somebody deleted
  // precisely so it would stop being visible.
  for (const shape of [
    query(),
    query({ scope: "mine" }),
    query({ period: "30d" }),
    query({ filters: [{ field: "status", operator: "equals", value: "won" }] }),
    // A config that tries to say otherwise. `deletedAt` is not in the catalogue,
    // so this is also the allowlist doing its job.
    query({ filters: [{ field: "deletedAt", operator: "is_not_empty" }] }),
  ]) {
    const where = compileWhere(leads, shape, ctx());
    assert.equal(where.deletedAt, null, "a soft-delete source must always exclude deleted rows");
  }
  for (const src of SOURCES.filter((s) => s.softDelete)) {
    assert.equal(compileWhere(src, query({ source: src.id }), ctx()).deletedAt, null, src.id);
  }
});

test("a source without soft delete does not invent the column", () => {
  // Activity has no `deletedAt`; emitting one would make every activity card
  // throw rather than leak, which is the harmless failure — but it would also
  // mean the exclusion above was being applied blindly rather than from the
  // catalogue.
  const where = compileWhere(activities, query({ source: "activities" }), ctx());
  assert.ok(!("deletedAt" in where), "a source that does not soft delete must not filter on it");
});

/* ── 3. `mine` narrows, never widens ──────────────────────────────── */

test("scope `mine` adds an owner predicate on top of the row scope, leaving it intact", () => {
  // The failure: implementing "mine" by REPLACING the row scope, which is the
  // tidier-looking code and turns the switch into a way to swap a narrow scope
  // for a broad one.
  const where = compileWhere(leads, query({ scope: "mine" }), ctx({ accessibleIds: ["a"] }));
  assert.deepEqual(where.id, { in: ["a"] }, "the row scope must survive the `mine` switch");
  assert.deepEqual(
    andOf(where).find((clause) => "assignedToId" in clause),
    { assignedToId: "user-1" },
    "`mine` must AND an owner predicate",
  );
});

test("scope `mine` on a source with no owner column matches nothing rather than everything", () => {
  // Vehicles have no user column, so "mine" cannot be expressed. Ignoring it
  // would answer a question about one person's records with the whole team's —
  // the card would be titled "my vehicles" and be nothing of the sort.
  const where = compileWhere(vehicles, query({ source: "vehicles", scope: "mine" }), ctx());
  assert.deepEqual(andOf(where), [IMPOSSIBLE], "an inexpressible `mine` must not widen the card");
});

test("scope `team` never removes the owner narrowing an owner-scoped source applies", () => {
  const where = compileWhere(
    activities,
    query({ source: "activities", scope: "team" }),
    ctx({ permissions: new Set(["activities.view"]) }),
  );
  assert.equal(where.assignedToId, "user-1", "`team` must not lift a source's own row scope");
});

/* ── 4. the field allowlist ───────────────────────────────────────── */

test("a filter naming an unknown field makes the query match nothing", () => {
  // Dropping the filter is the obvious implementation and the dangerous one:
  // "value over a million" removed from a card leaves "every lead". An empty
  // card is a visible, self-correcting failure; a silently broadened one is not.
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "passwordHash", operator: "contains", value: "x" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE], "an unresolvable filter must not simply vanish");
  // And nothing resembling the requested name may reach the query.
  assert.ok(!JSON.stringify(where).includes("passwordHash"), "an unknown field must not be passed through");
});

test("a filter with an operator its type does not support matches nothing", () => {
  // `contains` on an enum is absent from the catalogue's operator table on
  // purpose. Accepting it here would reintroduce it behind the editor's back.
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "status", operator: "contains", value: "op" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE]);
});

test("a filter carrying a value of the wrong shape matches nothing", () => {
  for (const filter of [
    { field: "value", operator: "greater_than" as const, value: "lots" },
    { field: "status", operator: "equals" as const, value: "not-a-status" },
    { field: "createdAt", operator: "greater_than" as const, value: "the fourth of never" },
    { field: "value", operator: "greater_than" as const },
  ]) {
    const where = compileWhere(leads, query({ filters: [filter] }), ctx());
    assert.deepEqual(andOf(where), [IMPOSSIBLE], `${filter.field}/${filter.operator} should not compile`);
  }
});

test("an unknown period field makes the window match nothing instead of becoming all-time", () => {
  // A period is a filter in friendlier clothing and fails the same way: a card
  // scoped to "this month" that quietly becomes "all time" is the same leak as a
  // dropped filter, in the one place nobody re-reads.
  const where = compileWhere(
    leads,
    query({ period: "month", periodField: "secretColumn" }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE]);
});

test("a period field that is not a date does not compile", () => {
  const where = compileWhere(leads, query({ period: "month", periodField: "status" }), ctx());
  assert.deepEqual(andOf(where), [IMPOSSIBLE], "a range predicate on an enum is not a period");
});

test("an unknown sort field falls back to the source default rather than reaching Prisma", () => {
  // Unlike a filter, a sort cannot widen anything — it only orders rows the
  // viewer may already see — so falling back is safe. What must not happen is
  // the raw name being emitted as a Prisma key.
  const order = compileOrderBy(leads, query({ sort: { field: "passwordHash", dir: "asc" } }));
  assert.deepEqual(order, { createdAt: "desc" }, "an unknown sort must fall back to the default");
});

test("an unknown column is dropped from the select", () => {
  const select = compileSelect(leads, ["name", "passwordHash"], ctx());
  assert.equal(select.name, true);
  assert.ok(!("passwordHash" in select), "an unknown column must not be selected");
});

test("every source's own date field resolves through the catalogue as a date", () => {
  // The compiler resolves the default period field by KEY, so a catalogue whose
  // `dateField` names something that is not a field key would make every
  // period-scoped card on that source match nothing.
  for (const src of SOURCES) {
    const field = resolveField(src, src.dateField, ctx(), "period");
    assert.ok(field, `${src.id}.dateField "${src.dateField}" does not resolve as a date field`);
  }
});

test("every source's default sort resolves, so the fallback order is real", () => {
  for (const src of SOURCES) {
    const order = compileOrderBy(src, query({ source: src.id }));
    assert.notDeepEqual(order, { id: "desc" }, `${src.id} has no usable default sort`);
  }
});

/* ── 5. field-level permission ────────────────────────────────────── */

test("a field the viewer lacks permission for is never selected", () => {
  // Deal value is the case the catalogue's per-field permission exists for:
  // someone running the diary may see that a lead exists and who owns it without
  // being trusted with what it is worth.
  const blind = ctx({ permissions: withoutPermission("leads.view_all") });
  const select = compileSelect(leads, ["name", "value"], blind);
  assert.ok(!("valueCents" in select), "a gated column must not be selected");
  assert.equal(select.name, true, "the ungated column must still come through");
  // Control: the same card for someone who holds the key.
  assert.equal(compileSelect(leads, ["name", "value"], ctx()).valueCents, true);
});

test("a field the viewer lacks permission for is never filtered on", () => {
  // A filter is an oracle. "Leads worth more than a million" answers a question
  // about the values without ever printing one, so the gate has to cover filters
  // as well as columns — and, being a filter, it fails closed.
  const blind = ctx({ permissions: withoutPermission("leads.view_all") });
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "value", operator: "greater_than", value: 1_000_000 }] }),
    blind,
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE]);
  assert.ok(!JSON.stringify(where).includes("valueCents"), "the gated column must not appear");
  // Control: the filter does compile for a viewer who may see values.
  const allowed = compileWhere(
    leads,
    query({ filters: [{ field: "value", operator: "greater_than", value: 1_000_000 }] }),
    ctx(),
  );
  assert.deepEqual(andOf(allowed), [{ valueCents: { gt: 100_000_000 } }]);
});

test("a gated field is never sorted by, aggregated over or grouped by", () => {
  const blind = ctx({ permissions: withoutPermission("leads.view_all") });
  // Ordering by a hidden money column ranks the rows by it, which discloses it
  // in every way that matters short of printing the number.
  assert.deepEqual(
    compileOrderBy(leads, query({ sort: { field: "value", dir: "desc" } })),
    { createdAt: "desc" },
    "a gated column must not order a card",
  );
  assert.equal(resolveField(leads, "value", blind, "aggregate"), null, "a gated column must not be totalled");
  assert.equal(resolveField(leads, "value", blind, "group"), null, "a gated column must not group a chart");
  // Control: aggregation is available to a viewer who holds the permission.
  assert.ok(resolveField(leads, "value", ctx(), "aggregate"), "the control case should resolve");
});

test("cellValues refuses to read a gated field back out of a row", () => {
  const blind = ctx({ permissions: withoutPermission("leads.view_all") });
  const row = { id: "l1", name: "Jane", valueCents: 999_00 };
  assert.deepEqual(cellValues(leads, "value", row, blind), [], "a gated value must not be readable");
  assert.deepEqual(cellValues(leads, "value", row, ctx()), [999_00]);
});

/* ── 6. composite fields are display-only ─────────────────────────── */

test("a composite field selects every one of its parts", () => {
  // A person's name is three columns and one idea. All of them are selected so
  // the renderer can join them; that is the only thing a composite may do.
  const select = compileSelect(contacts, ["name"], ctx());
  assert.equal(select.firstName, true);
  assert.equal(select.lastName, true);
  assert.equal(select.company, true);
});

test("a composite field cannot be filtered, sorted or grouped", () => {
  // "Surname contains 'du'" and "company contains 'du'" are different questions
  // and a joined value answers neither honestly — the parts are listed
  // separately in the catalogue for exactly this.
  assert.equal(resolveField(contacts, "name", ctx(), "filter"), null);
  assert.equal(resolveField(contacts, "name", ctx(), "sort"), null);
  assert.equal(resolveField(contacts, "name", ctx(), "group"), null);
  assert.ok(resolveField(contacts, "name", ctx(), "select"), "it must still be displayable");
  const where = compileWhere(
    contacts,
    query({ source: "contacts", filters: [{ field: "name", operator: "contains", value: "du" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE], "a composite filter must not compile");
});

test("a composite field is display-only even when the catalogue forgets to say so", () => {
  // The test above passes today for a reason that is not the compiler: every
  // composite in the catalogue ALSO carries `filterable: false`, so it never
  // reaches the composite rule. Deleting the rule breaks nothing — which means
  // the rule is only as good as the next person remembering three flags on a new
  // field. This is the guard that holds without them.
  const forgetful: SourceDef = {
    ...contacts,
    fields: [
      { key: "createdAt", label: "Added", type: "date", path: "createdAt" },
      { key: "name", label: "Name", type: "text", path: "firstName", paths: ["lastName", "company"] },
    ],
  };
  assert.equal(resolveField(forgetful, "name", ctx(), "filter"), null, "a composite must never filter");
  assert.equal(resolveField(forgetful, "name", ctx(), "sort"), null, "a composite must never sort");
  assert.equal(resolveField(forgetful, "name", ctx(), "group"), null, "a composite must never group");
  assert.ok(resolveField(forgetful, "name", ctx(), "select"), "it must still be displayable");
  const where = compileWhere(
    forgetful,
    query({ source: "contacts", filters: [{ field: "name", operator: "contains", value: "du" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE]);
});

test("the catalogue also marks every composite unfilterable, so the editor never offers it", () => {
  // Belt and braces for the layer above: the compiler refuses a composite filter
  // whatever the flags say, but an editor that OFFERS one produces a card that
  // silently shows nothing, and the person who built it has no way to see why.
  for (const src of SOURCES) {
    for (const field of src.fields.filter((f) => f.paths)) {
      assert.equal(field.filterable, false, `${src.id}.${field.key} is composite but filterable`);
      assert.equal(field.sortable, false, `${src.id}.${field.key} is composite but sortable`);
      assert.notEqual(field.groupable, true, `${src.id}.${field.key} is composite but groupable`);
    }
  }
});

/* ── 7. money is cents ────────────────────────────────────────────── */

test("a money filter written in rands is compared in cents", () => {
  // Off by a hundred here means "over R5 000" filters on R50, which returns the
  // whole pipeline and looks like a working card.
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "value", operator: "greater_than", value: 5000 }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [{ valueCents: { gt: 500_000 } }]);
});

test("a money filter with cents in it survives the conversion", () => {
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "value", operator: "equals", value: 12.34 }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [{ valueCents: 1234 }]);
});

test("a plain number field is NOT multiplied", () => {
  // The other half of the same mistake: applying the conversion by operator or
  // by name rather than by the catalogue's declared type.
  const where = compileWhere(
    leads,
    query({ filters: [{ field: "quantity", operator: "greater_than", value: 5 }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [{ quantity: { gt: 5 } }]);
});

/* ── 8. no raw SQL, and one relation hop at most ──────────────────── */

test("the compiler contains no raw SQL of any kind", () => {
  // Comments are stripped first, so this is about what the module DOES rather
  // than about which words appear in its prose.
  const code = source("src/lib/dashboard/compile.ts")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");
  for (const forbidden of ["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]) {
    assert.ok(!code.includes(forbidden), `compile.ts must not reach for ${forbidden}`);
  }
  // basePrisma bypasses the soft-delete filter and the RLS session scope. A
  // query built from a saved config is the last thing that should run on it.
  assert.ok(!code.includes("basePrisma"), "the compiler must use the extended prisma client");
  assert.ok(
    code.includes('const { prisma } = await import("@/lib/db")'),
    "the compiler must take the extended client and nothing else",
  );
});

test("a relation hop compiles to a nested where, not a dotted key", () => {
  const where = compileWhere(
    quotes,
    query({ source: "quotes", filters: [{ field: "lead", operator: "contains", value: "acme" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [{ lead: { name: { contains: "acme", mode: "insensitive" } } }]);
  const select = compileSelect(quotes, ["contact"], ctx());
  assert.deepEqual(select.contact, {
    select: { firstName: true, lastName: true, company: true },
  });
});

test("a path with two hops does not compile at all", () => {
  // One hop is a rule about blast radius rather than about Prisma's abilities:
  // the accessible-id helpers scope the ROOT model, and every further hop is
  // another model whose own permissions nobody consulted.
  const deep: SourceDef = {
    ...leads,
    fields: [
      { key: "createdAt", label: "Created", type: "date", path: "createdAt" },
      { key: "deep", label: "Deep", type: "text", path: "contact.owner.email" },
    ],
  };
  assert.equal(resolveField(deep, "deep", ctx(), "filter"), null, "two hops must not resolve");
  assert.equal(resolveField(deep, "deep", ctx(), "select"), null);
  const where = compileWhere(
    deep,
    query({ filters: [{ field: "deep", operator: "contains", value: "@" }] }),
    ctx(),
  );
  assert.deepEqual(andOf(where), [IMPOSSIBLE]);
  assert.deepEqual(compileSelect(deep, ["deep"], ctx()), { id: true });
});

test("no catalogue path reaches further than one hop", () => {
  for (const src of SOURCES) {
    for (const field of src.fields) {
      for (const p of [field.path, ...(field.paths ?? [])]) {
        assert.ok(
          p.split(".").length <= 2,
          `${src.id}.${field.key} points at "${p}", which is more than one relation hop`,
        );
      }
    }
  }
});

/* ── 9. the row limit is clamped ──────────────────────────────────── */

test("a list card cannot ask for more rows than the cap, whatever the config says", () => {
  // The parser caps this too, but a stored config can predate the cap and a
  // caller can hand-build the query object, so the clamp lives at the query.
  assert.equal(compileTake(query({ limit: 5000 })), LIMITS.listRows);
  assert.equal(compileTake(query({ limit: LIMITS.listRows })), LIMITS.listRows);
  assert.equal(compileTake(query({ limit: 8 })), 8);
  // And it stays a positive integer: `take: 0` returns nothing and `take: -1`
  // is a Prisma error on the home page.
  assert.equal(compileTake(query({ limit: 0 })), 1);
  assert.equal(compileTake(query({ limit: -3 })), 1);
  assert.equal(compileTake(query({ limit: Number.NaN })), 1);
});

/* ── periods ──────────────────────────────────────────────────────── */

test("every period in the catalogue compiles to a window", () => {
  const now = new Date("2026-08-05T14:30:00.000Z");
  for (const period of PERIODS) {
    const range = periodRange(period.id, now);
    if (period.id === "all") {
      assert.equal(range, null, "all time must be no predicate at all");
      continue;
    }
    assert.ok(range, `${period.id} produced no window at all`);
    if (period.id.startsWith("older_")) {
      /*
       * The stale windows are open-ended on the early side, and that is the
       * whole point of them. "Older than 30 days" must mean everything up to
       * that cut, not the month before it — a lead untouched for two years is
       * MORE stale than one untouched for five weeks, and a lower bound would
       * silently drop exactly the rows the card exists to surface.
       */
      assert.equal(range.gte, undefined, `${period.id} must not have a lower bound`);
      assert.ok(range.lt instanceof Date, `${period.id} needs an upper bound`);
      continue;
    }
    assert.ok(range.gte instanceof Date && range.lt instanceof Date, `${period.id} needs both bounds`);
    assert.ok(range.gte < range.lt, `${period.id} produced an empty window`);
  }
});

test("a stale window and its matching recent window partition the timeline", () => {
  /*
   * "Last 7 days" and "older than 7 days" sit next to each other in the picker
   * and a user will read them as opposites. If the two overlapped, a row would
   * appear on both cards at once; if they left a gap, a row would fall off both
   * and be invisible to someone who built the pair deliberately to cover
   * everything. Neither is discoverable by looking at either card alone.
   */
  const now = new Date(2026, 7, 5, 14, 30);
  for (const [recent, stale] of [
    ["7d", "older_7d"],
    ["30d", "older_30d"],
    ["90d", "older_90d"],
  ] as const) {
    const a = periodRange(recent, now)!;
    const b = periodRange(stale, now)!;
    assert.equal(
      b.lt!.getTime(),
      a.gte!.getTime(),
      `${recent} and ${stale} do not meet exactly — a row falls into both or neither`,
    );
  }
});

test("the rolling windows are calendar-aligned and half-open", () => {
  const now = new Date(2026, 7, 5, 14, 30);
  const today = periodRange("today", now);
  assert.deepEqual(today, { gte: new Date(2026, 7, 5), lt: new Date(2026, 7, 6) });
  // "Today" must be a strict subset of "last 7 days", or two cards side by side
  // contradict each other and it reads as broken data.
  const week = periodRange("7d", now);
  assert.deepEqual(week, { gte: new Date(2026, 6, 30), lt: new Date(2026, 7, 6) });
  assert.ok(week!.gte! <= today!.gte! && week!.lt!.getTime() === today!.lt!.getTime());
});

test("month windows carry an upper bound, because several date fields run into the future", () => {
  // `validUntil` and `deliveryScheduledFor` are legitimately in the future. A
  // "this month" with no upper bound sweeps in next year's bookings.
  const now = new Date(2026, 7, 5, 14, 30);
  assert.deepEqual(periodRange("month", now), { gte: new Date(2026, 7, 1), lt: new Date(2026, 8, 1) });
  assert.deepEqual(periodRange("last_month", now), {
    gte: new Date(2026, 6, 1),
    lt: new Date(2026, 7, 1),
  });
  assert.deepEqual(periodRange("year", now), { gte: new Date(2026, 0, 1), lt: new Date(2027, 0, 1) });
});

test("a period predicate is ANDed onto the scoped where rather than replacing it", () => {
  const where = compileWhere(leads, query({ period: "month" }), ctx({ accessibleIds: ["a"] }));
  assert.deepEqual(where.id, { in: ["a"] });
  assert.equal(where.deletedAt, null);
  const clause = andOf(where)[0] as { createdAt: { gte: Date; lt: Date } };
  assert.ok(clause.createdAt.gte instanceof Date, "the period must compile against the source's date field");
});

/* ── the select always links somewhere ────────────────────────────── */

test("every list row can be linked to its record", () => {
  // `href` substitutes `:id`, so a select without `id` produces rows that look
  // right and go nowhere.
  assert.equal(compileSelect(leads, [], ctx()).id, true);
  assert.equal(compileSelect(leads, ["name"], ctx()).id, true);
  for (const src of SOURCES) {
    assert.equal(compileSelect(src, [...src.defaultColumns], ctx()).id, true, src.id);
  }
});

test("every source's default columns survive compilation for a fully privileged viewer", () => {
  // A default column that does not resolve would mean a new card on that source
  // renders blank out of the box.
  for (const src of SOURCES) {
    const select = compileSelect(src, [...src.defaultColumns], ctx());
    assert.ok(
      Object.keys(select).length > 1,
      `${src.id}'s default columns compiled to nothing but the id`,
    );
  }
});

/* ── the catalogue and the compiler agree about what exists ───────── */

test("every source in the catalogue is bound to a model", () => {
  // The binding sources.ts promises lives here. A source with no model would
  // throw on the home page at render time rather than at build time.
  for (const src of SOURCES) {
    assert.ok(MODEL_BY_SOURCE[src.id], `${src.id} has no Prisma model in MODEL_BY_SOURCE`);
  }
  assert.equal(
    Object.keys(MODEL_BY_SOURCE).length,
    SOURCES.length,
    "MODEL_BY_SOURCE and SOURCES disagree about which sources exist",
  );
});

/* ── the arrangement that makes all of the above testable ─────────── */

test("the compiler reaches Prisma only through a dynamic import", () => {
  // Every guard in this file depends on compile.ts being importable without a
  // database. A static `import { prisma } from "@/lib/db"` — or a `server-only`
  // marker — would construct a PrismaClient at load and take the whole suite
  // down with it, and the tempting fix at that point is to delete the tests.
  const text = source("src/lib/dashboard/compile.ts");
  assert.ok(
    !/^import\s[^\n]*from "@\/lib\/db"/m.test(text),
    "compile.ts must not import the Prisma client statically",
  );
  assert.ok(!/^import "server-only"/m.test(text), "compile.ts must not be marked server-only");
  assert.ok(text.includes('await import("@/lib/db")'), "the client must be reached lazily");
  // data.ts carries `server-only` and is likewise imported lazily — which is
  // what still keeps the query path out of a client bundle, because a bundler
  // resolves a dynamic import just as it resolves a static one.
  assert.ok(text.includes('await import("./data")'), "the shared scope helpers must be reused");
});

test("the compiler reuses the shared, memoised scope helpers rather than new ones", () => {
  // Two independent scope resolutions is two chances to disagree about what a
  // null id list means, and one extra query per card on the first screen every
  // user sees.
  const text = source("src/lib/dashboard/compile.ts");
  for (const helper of ["leadWhere", "quoteWhere", "vehicleWhere", "jobCardWhere"]) {
    assert.ok(text.includes(`data.${helper}()`), `compile.ts must reuse data.ts's ${helper}`);
  }
  assert.ok(
    text.includes("getAccessibleContactIds"),
    "contacts have no helper in data.ts and must call the permissions helper directly",
  );
  assert.ok(text.includes("cache("), "the contact scope must be memoised per request");
});

/* ── the source gate ──────────────────────────────────────────────── */

/**
 * `canUseSource` IS THE GATE, AND IT HAD NO CALLERS.
 *
 * sources.ts states the rule its catalogue is built on — "module state is a
 * TENANT entitlement no role overrides, permission is WHO, and both must pass" —
 * and the function that enforces it was wired only to `usableSources`, which
 * fills the editor's dropdowns. The read path never consulted it.
 *
 * The permission half held anyway, by a route it was not designed for:
 * getAccessible*Ids returns [] rather than null when the viewer holds neither
 * grant, so those cards came back empty. That is exactly why this went unnoticed.
 *
 * The MODULE half did not hold. `jobcards` and `vehicles` carry
 * module: "automotive", and a viewer with jobcards.view_all gets
 * accessibleIds = null — no id predicate — so a card built while the module was
 * enabled kept rendering workshop data after the tenant lost it. No attacker
 * required: the editor stops offering the source, and the saved card carries on.
 */

test("a source the viewer may not use compiles to a query matching nothing", () => {
  for (const src of SOURCES) {
    const where = compileWhere(src, query({ source: src.id }), ctx({ usable: false }));
    assert.deepEqual(
      where,
      { id: { in: [] } },
      `${src.id} compiled something other than the impossible query when refused`,
    );
  }
});

test("nothing in a refused card's config can widen it", () => {
  // The early return is what makes this true: a filter, a period, a `mine`
  // switch and a sort are all downstream of it, so none of them runs. Asserted
  // rather than assumed, because "it returns early" is a property of today's
  // control flow and this is a property of the output.
  const where = compileWhere(
    vehicles,
    query({
      source: "vehicles",
      scope: "mine",
      period: "30d",
      filters: [{ field: "model", operator: "contains", value: "Denago" }],
    }),
    ctx({ usable: false, accessibleIds: null, permissions: EVERY_PERMISSION }),
  );
  // Checked BEFORE the deepEqual: assert.deepEqual is a type assertion, so it
  // narrows `where` to the expected literal and every property read after it
  // stops being a question about the value.
  assert.equal(where.AND, undefined, "no filter, period or scope predicate may survive a refusal");
  assert.equal(where.deletedAt, undefined, "not even the soft-delete key — the query is closed, not narrowed");
  assert.deepEqual(where, { id: { in: [] } });
});

test("a refused OWNER-scoped source stops handing back the viewer's own rows", () => {
  // Activities are the one source scoped by an ownership column rather than an
  // accessible-id helper, and the one the indirect enforcement above never
  // covered: with no activities permission at all, the owner branch still
  // emitted `assignedToId = me`, so a viewer the record page refuses outright
  // got their own diary on a card.
  const refused = compileWhere(activities, query({ source: "activities" }), ctx({ usable: false }));
  assert.ok(
    !Object.values(refused).includes("user-1"),
    "a refused source must not fall back to the viewer's own rows",
  );
  assert.deepEqual(refused, { id: { in: [] } });

  // …and the permitted case is untouched: still their own diary, not everyone's.
  const permitted = compileWhere(
    activities,
    query({ source: "activities" }),
    ctx({ permissions: withoutPermission("activities.manage") }),
  );
  assert.equal(permitted.assignedToId, "user-1");
});

test("the gate is called on the read path, not only in the editor", () => {
  // The regression that started this: `canUseSource` existed, was correct, was
  // documented, and had zero callers outside the dropdown helpers. A gate nobody
  // invokes is decoration, and it reads exactly like a gate that works.
  const compile = readFileSync(path.join(root, "src/lib/dashboard/compile.ts"), "utf8");
  assert.match(compile, /canUseSource,/, "compile.ts must import the gate");
  assert.match(
    compile,
    /if \(!canUseSource\(source, access\)\) \{/,
    "scopeContext must consult it before resolving any scope",
  );
  assert.match(compile, /if \(!ctx\.usable\) return \{ \.\.\.IMPOSSIBLE \};/, "compileWhere must honour it");

  // Ordered before the scope resolution, or a denied viewer's accessible ids get
  // resolved and the early return becomes decoration of a different kind.
  const gateAt = compile.indexOf("if (!canUseSource(source, access))");
  const scopeAt = compile.indexOf("let accessibleIds: string[] | null = null;");
  assert.ok(gateAt !== -1 && scopeAt !== -1 && gateAt < scopeAt, "the gate must precede scope resolution");

  // And it must be the FIRST thing compileWhere does — a soft-delete key or a
  // row scope written before it would survive into the refused query.
  const body = compile.slice(compile.indexOf("export function compileWhere("));
  assert.ok(
    body.indexOf("if (!ctx.usable)") < body.indexOf("const where: Record<string, unknown> = {}"),
    "the refusal must come before the where object is built",
  );
});

test("a refused context is closed on more than one axis", () => {
  // Defence in depth at the one place that knows the viewer: `usable` stops
  // compileWhere, the empty id list closes the scope for any future caller that
  // builds a where by hand, and NO_PERMISSIONS stops a gated column resolving
  // into a select or an aggregate.
  const compile = readFileSync(path.join(root, "src/lib/dashboard/compile.ts"), "utf8");
  assert.match(
    compile,
    /return \{ userId: user\.id, accessibleIds: \[\], permissions: NO_PERMISSIONS, usable: false \};/,
  );
});
