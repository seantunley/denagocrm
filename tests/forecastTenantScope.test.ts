import test from "node:test";
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A FORECAST TOTAL MUST CONTAIN ONE WORKSPACE'S DEALS.
 *
 * `captureForecastSnapshot` called `listForecastLeads` with no `pipelineId` —
 * which is what "All pipelines", the default, sends — and that query's only
 * boundary was `tenantFilter`, which is `Prisma.empty` while enforcement is
 * dormant, on `basePrisma`, the documented RLS bypass. So the snapshot summed
 * EVERY workspace's open leads and then WROTE THE RESULT DOWN, stamped with one
 * tenant. Persisted, so the wrong number outlives the fix; and an aggregate, so
 * nothing on screen looks foreign — a total is not inspectable, and another
 * dealer's pipeline folded into yours reads exactly like a good month.
 *
 * ── WHY THIS TEST LOOKS LIKE THIS ──────────────────────────────────────────
 *
 * Its sibling, `pipelineTenantIsolation.test.ts`, executes the pure rule in
 * `pipelineTenantRule.ts` with two tenant ids. That proves the RULE and cannot
 * prove the WIRING — the defect here was never a wrong rule, it was a correct rule
 * that one query did not call. And a source assertion cannot prove an arithmetic
 * claim: "the predicate is present" is not "the number is right", which is the
 * distinction the tenant ratchet's `tenantId`-appears-somewhere heuristic keeps
 * missing (twice now).
 *
 * So this drives the REAL `captureForecastSnapshot`, with `writeTenantId()`
 * returning null exactly as it does in production today, against a fake database
 * that EVALUATES the tenant predicate the function emits — reading the bound value
 * out of the flattened SQL rather than being told what it should be. Drop the
 * predicate and the fake stops filtering, which is what the real database would
 * do. The `MUTATION` test at the bottom does precisely that, on the SQL the
 * production code just emitted, and asserts the total changes.
 */

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

const TENANT_A = "tenant_denago_cpt";
const TENANT_B = "tenant_second_dealer";

/* ── the two workspaces ───────────────────────────────────────────────────── */

type LeadRow = {
  id: string;
  tenantId: string | null;
  title: string;
  name: string;
  status: string;
  deletedAt: Date | null;
  valueCents: number;
  estimatedCostCents: number | null;
  probability: number;
  forecastCategory: string;
  expectedCloseDate: Date | null;
  pipelineId: string;
  stageId: string;
  assignedToId: string | null;
  teamId: string | null;
};

const lead = (row: Partial<LeadRow> & Pick<LeadRow, "id" | "tenantId" | "valueCents" | "probability">): LeadRow => ({
  title: `Deal ${row.id}`,
  name: `Buyer ${row.id}`,
  status: "open",
  deletedAt: null,
  estimatedCostCents: null,
  forecastCategory: "pipeline",
  expectedCloseDate: new Date(Date.UTC(2026, 7, 14)),
  pipelineId: row.tenantId === TENANT_B ? "pipe_b" : "pipe_a",
  stageId: "stage_1",
  assignedToId: null,
  teamId: null,
  ...row,
});

/**
 * Values chosen so no total can be mistaken for another: A's open value is
 * R380 000, B's is R715 000, and the unowned row alone is R999 999.
 */
const LEADS: LeadRow[] = [
  lead({ id: "a1", tenantId: TENANT_A, valueCents: 25_000_000, probability: 60, forecastCategory: "commit" }),
  lead({ id: "a2", tenantId: TENANT_A, valueCents: 9_000_000, probability: 25, forecastCategory: "best_case" }),
  lead({ id: "a3", tenantId: TENANT_A, valueCents: 4_000_000, probability: 10, forecastCategory: "pipeline" }),
  lead({ id: "b1", tenantId: TENANT_B, valueCents: 70_000_000, probability: 90, forecastCategory: "commit" }),
  lead({ id: "b2", tenantId: TENANT_B, valueCents: 1_500_000, probability: 50, forecastCategory: "best_case" }),
  // Already won: excluded by `status = 'open'`, which is a literal in the query.
  // Present so a fake that simply returned everything would fail the A case too.
  lead({ id: "a_won", tenantId: TENANT_A, valueCents: 50_000_000, probability: 100, status: "won" }),
  // Owned by NOBODY. Strict equality must exclude it from every workspace — the
  // rule `pipelineTenantRule.ts` argues for, here as an arithmetic consequence.
  lead({ id: "u1", tenantId: null, valueCents: 99_999_900, probability: 100, forecastCategory: "commit" }),
];

/** The arithmetic the assertions below are stated against, computed from the fixture. */
const openValueOf = (...tenants: Array<string | null>) =>
  LEADS.filter((l) => l.status === "open" && tenants.includes(l.tenantId))
    .reduce((total, l) => total + l.valueCents, 0);

const A_OPEN = openValueOf(TENANT_A);          //  38 000 000 = R380 000
const B_OPEN = openValueOf(TENANT_B);          //  71 500 000 = R715 000
const EVERYONE_OPEN = openValueOf(TENANT_A, TENANT_B, null); // 209 499 900 = R2 094 999

const PIPELINES = [
  { id: "pipe_a", tenantId: TENANT_A, active: true },
  { id: "pipe_b", tenantId: TENANT_B, active: true },
];

const SNAPSHOTS = [
  { id: "snap_a", tenantId: TENANT_A, period: "2026-07", openValueCents: BigInt(11) },
  { id: "snap_b", tenantId: TENANT_B, period: "2026-07", openValueCents: BigInt(22) },
];

const TEAMS = [
  { id: "team_a", tenantId: TENANT_A, active: true, deletedAt: null },
  { id: "team_b", tenantId: TENANT_B, active: true, deletedAt: null },
];

/* ── a database that reads the predicate instead of being told it ─────────── */

type Flat = { text: string; values: unknown[] };

function isSql(value: unknown): value is { strings: readonly string[]; values: readonly unknown[] } {
  return typeof value === "object" && value !== null
    && Array.isArray((value as { strings?: unknown }).strings)
    && Array.isArray((value as { values?: unknown }).values);
}

/**
 * Flatten a tagged template the way the Prisma driver does: nested `Prisma.Sql`
 * fragments are spliced into the text, every other interpolation becomes a
 * numbered placeholder bound to a value. This is what makes the fake able to
 * SEE whether a tenant predicate reached the database, and what it bound.
 */
function flatten(strings: readonly string[], values: readonly unknown[]): Flat {
  const out: string[] = [];
  const params: unknown[] = [];
  const walk = (ss: readonly string[], vs: readonly unknown[]) => {
    for (let i = 0; i < ss.length; i += 1) {
      out.push(ss[i]);
      if (i >= vs.length) continue;
      const value = vs[i];
      if (isSql(value)) walk(value.strings, value.values);
      else {
        params.push(value);
        out.push(`$${params.length}`);
      }
    }
  };
  walk(strings, values);
  // Joined with nothing — the template's own whitespace is the SQL's — then
  // normalised so a regex does not have to model the source's indentation.
  return { text: out.join("").replace(/\s+/g, " ").trim(), values: params };
}

/** The value a predicate binds, or `undefined` when the predicate is not there at all. */
function bound(flat: Flat, pattern: RegExp): unknown {
  const match = flat.text.match(pattern);
  if (!match) return undefined;
  return flat.values[Number(match[1]) - 1];
}

/** Every statement the code under test issued, in order, flattened. */
const issued: Flat[] = [];

/**
 * THE MUTATION SWITCH. When set, the tenant predicate is deleted from the SQL the
 * production code emitted, immediately before the fake evaluates it — reproducing
 * the defect exactly, on the real statement, with nothing else changed.
 */
let dropTenantPredicate = false;

function forecastLeads(flat: Flat) {
  const text = dropTenantPredicate ? flat.text.replace(/AND l\."tenantId" = \$\d+/, "") : flat.text;
  const scoped: Flat = { text, values: flat.values };
  const tenantId = bound(scoped, /AND l\."tenantId" = \$(\d+)/);
  const pipelineId = bound(scoped, /OR l\."pipelineId" = \$(\d+)/);
  const teamId = bound(scoped, /OR l\."teamId" = \$(\d+)/);
  const userId = bound(scoped, /OR l\."assignedToId" = \$(\d+)/);
  const closeFrom = bound(scoped, /l\."expectedCloseDate" >= \$(\d+)/) as Date | null | undefined;
  const closeTo = bound(scoped, /l\."expectedCloseDate" < \$(\d+)/) as Date | null | undefined;

  // These are literals in the statement, not parameters, so they are asserted
  // rather than parsed — a query that lost them would be a different bug.
  assert.match(scoped.text, /l\."deletedAt" IS NULL AND l\."status" = 'open'/);

  return LEADS.filter((row) => {
    if (row.deletedAt !== null || row.status !== "open") return false;
    // `undefined` means the predicate is ABSENT — the unbounded read. `null` means
    // it is present and matches everything, which is what the optional filters do.
    if (tenantId !== undefined && row.tenantId !== tenantId) return false;
    if (pipelineId != null && row.pipelineId !== pipelineId) return false;
    if (teamId != null && row.teamId !== teamId) return false;
    if (userId != null && row.assignedToId !== userId) return false;
    if (closeFrom != null && !(row.expectedCloseDate && row.expectedCloseDate >= closeFrom)) return false;
    if (closeTo != null && !(row.expectedCloseDate && row.expectedCloseDate < closeTo)) return false;
    return true;
  }).map((row) => ({
    ...row,
    pipelineName: row.pipelineId,
    stageName: row.stageId,
    assignedToName: null,
    teamName: null,
    updatedAt: new Date(0),
  }));
}

/** Rows written to ForecastSnapshot: column name → bound value, as the INSERT ordered them. */
const written: Array<Record<string, unknown>> = [];
/** Rows the UPDATE statement reached. */
const updated: string[] = [];

function insertSnapshot(flat: Flat) {
  const columns = /INSERT INTO "ForecastSnapshot" \(([^)]*)\)/.exec(flat.text);
  assert.ok(columns, "the snapshot insert must name its columns");
  const names = columns[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  assert.equal(names.length, flat.values.length, "every column must be bound, none spliced");
  written.push(Object.fromEntries(names.map((name, index) => [name, flat.values[index]])));
  return 1;
}

function updateLead(flat: Flat) {
  const id = bound(flat, /WHERE "id" = \$(\d+)/);
  const tenantId = bound(flat, /AND "tenantId" = \$(\d+)/);
  const hit = LEADS.filter((row) =>
    row.id === id && row.deletedAt === null && (tenantId === undefined || row.tenantId === tenantId));
  for (const row of hit) updated.push(row.id);
  return hit.length;
}

const raw = async (strings: readonly string[], ...values: unknown[]) => {
  const flat = flatten(strings, values);
  issued.push(flat);

  if (/FROM "Lead" l/.test(flat.text)) return forecastLeads(flat);

  if (/SELECT "id", "tenantId", "active" FROM "SalesPipeline"/.test(flat.text)) {
    const id = bound(flat, /WHERE "id" = \$(\d+)/);
    const tenantId = bound(flat, /AND "tenantId" = \$(\d+)/);
    return PIPELINES.filter((row) => row.id === id && (tenantId === undefined || row.tenantId === tenantId));
  }

  if (/FROM "ForecastSnapshot" fs/.test(flat.text)) {
    const tenantId = bound(flat, /AND fs\."tenantId" = \$(\d+)/);
    return SNAPSHOTS.filter((row) => tenantId === undefined || row.tenantId === tenantId);
  }

  if (/FROM "Team"/.test(flat.text)) {
    const id = bound(flat, /WHERE "id" = \$(\d+)/);
    const tenantId = bound(flat, /AND "tenantId" = \$(\d+)/);
    return TEAMS.filter((row) =>
      row.id === id && row.active && row.deletedAt === null && (tenantId === undefined || row.tenantId === tenantId));
  }

  if (/FROM "Lead"/.test(flat.text)) {
    const id = bound(flat, /WHERE "id" = \$(\d+)/);
    const tenantId = bound(flat, /AND "tenantId" = \$(\d+)/);
    return LEADS.filter((row) =>
      row.id === id && row.deletedAt === null && (tenantId === undefined || row.tenantId === tenantId));
  }

  if (/INSERT INTO "ForecastSnapshot"/.test(flat.text)) return insertSnapshot(flat);
  if (/UPDATE "Lead"/.test(flat.text)) return updateLead(flat);

  throw new Error(`the fake database was asked something it does not model: ${flat.text.slice(0, 120)}`);
};

const basePrisma = { $queryRaw: raw, $executeRaw: raw };

/* ── load the real module against it, with enforcement DORMANT ────────────── */

/** Whoever is signed in. `writeTenantId()` stays null, exactly as in production. */
let acting = TENANT_A;
/** How many times one operation read the security principal. */
let actingCalls = 0;

const stubs: Record<string, unknown> = {
  "./db": { basePrisma, prisma: basePrisma },
  "./actingTenant": { actingTenantId: async () => { actingCalls += 1; return acting; } },
  // DORMANT. This is the production configuration, and the reason the defect was
  // reachable at all: every scope derived from these is empty or null.
  "./tenantWrite": { currentScopeClass: () => ({ mode: "global" as const }), writeTenantId: () => null },
};

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request in stubs && parent?.filename?.endsWith("pipelines.ts")) return stubs[request];
  if (request === "server-only" || request === "client-only") return {};
  return realLoad.call(this, request, parent, isMain);
} as Loader;

// `pipelineTenantRule.ts` is deliberately NOT stubbed: the rule under test is the
// one production runs.
const pipelines = createRequire(import.meta.url)("../src/lib/pipelines.ts") as typeof import("../src/lib/pipelines");

const AUGUST = { closeFrom: new Date(Date.UTC(2026, 7, 1)), closeTo: new Date(Date.UTC(2026, 8, 1)) };

/** What `snapshotForecast` in the action layer builds and hands down, month included. */
const snapshotAs = async (tenantId: string, input: { pipelineId?: string | null; teamId?: string | null; userId?: string | null } = {}) => {
  acting = tenantId;
  written.length = 0;
  issued.length = 0;
  actingCalls = 0;
  const args = { period: "2026-08", ...input, closeFrom: AUGUST.closeFrom, closeTo: AUGUST.closeTo };
  const summary = await pipelines.captureForecastSnapshot(args);
  return { summary, row: written[0] };
};

/* ── the aggregate ────────────────────────────────────────────────────────── */

test("a snapshot taken by A totals only A's leads", async () => {
  const { summary, row } = await snapshotAs(TENANT_A);

  assert.equal(summary.openValueCents, A_OPEN, `A's open pipeline must be ${A_OPEN}, not ${EVERYONE_OPEN}`);
  assert.equal(summary.openValueCents, 38_000_000);
  assert.equal(summary.count, 3, "three open leads, not six");
  assert.equal(summary.commitValueCents, 25_000_000);
  assert.equal(summary.bestCaseValueCents, 9_000_000);
  assert.equal(summary.pipelineValueCents, 4_000_000);
  // 25 000 000 × 60% + 9 000 000 × 25% + 4 000 000 × 10%
  assert.equal(summary.weightedValueCents, 17_650_000);

  // Stated as the property as well as the number: B's value is not in there, and
  // neither is the unowned row's.
  assert.notEqual(summary.openValueCents, EVERYONE_OPEN);
  assert.ok(summary.openValueCents < B_OPEN, "A's total must not have absorbed the larger workspace");

  // And the row that gets KEPT carries the same boundary it was computed under.
  assert.equal(row.tenantId, TENANT_A, "a snapshot must not be born unowned or foreign");
  assert.equal(row.openValueCents, BigInt(A_OPEN));
  assert.equal(row.opportunityCount, 3);
});

test("a snapshot taken by B totals only B's leads", async () => {
  const { summary, row } = await snapshotAs(TENANT_B);

  assert.equal(summary.openValueCents, B_OPEN);
  assert.equal(summary.openValueCents, 71_500_000);
  assert.equal(summary.count, 2);
  assert.equal(summary.weightedValueCents, 63_750_000);
  assert.equal(row.tenantId, TENANT_B);

  // The two workspaces must not merely differ from the combined figure — they must
  // differ from EACH OTHER, which an "everyone sees everything" bug cannot do.
  assert.notEqual(summary.openValueCents, A_OPEN);
  assert.equal(A_OPEN + B_OPEN + 99_999_900, EVERYONE_OPEN, "the fixture's arithmetic");
});

test("an unowned lead belongs to nobody's forecast", async () => {
  // 99 999 900 is more than either workspace's entire pipeline, so a fallback that
  // handed NULL rows to the founding tenant would be unmissable here.
  const a = await snapshotAs(TENANT_A);
  const b = await snapshotAs(TENANT_B);
  assert.ok(a.summary.openValueCents < 99_999_900, "the founding tenant absorbed the unowned lead");
  assert.ok(b.summary.openValueCents < 99_999_900);
  assert.equal(a.summary.openValueCents + b.summary.openValueCents + 99_999_900, EVERYONE_OPEN);
});

test("the statement the database runs binds the acting workspace", async () => {
  await snapshotAs(TENANT_A);
  const query = issued.find((flat) => /FROM "Lead" l/.test(flat.text));
  assert.ok(query, "the forecast must actually query leads");
  // The Lead alias, not the joined SalesPipeline or PipelineStage: scoping either
  // of those bounds the JOIN and not the set of deals being summed.
  assert.match(query.text, /AND l\."tenantId" = \$\d+/);
  assert.equal(bound(query, /AND l\."tenantId" = \$(\d+)/), TENANT_A);
  assert.doesNotMatch(query.text, /IS NULL OR l\."tenantId"/, "no unowned-row escape hatch");
});

test("the snapshot's scope and its stamp come from one reading of the principal", async () => {
  // Resolve twice and they could disagree: tenant A's row stamped with tenant B's
  // revenue is not a shape any later query or audit can detect, and this runs on
  // basePrisma, which has no guard behind it to notice.
  const { row } = await snapshotAs(TENANT_B, { pipelineId: "pipe_b" });
  assert.equal(actingCalls, 1, `captureForecastSnapshot resolved the acting tenant ${actingCalls} times`);
  assert.equal(row.tenantId, TENANT_B);
  assert.equal(row.pipelineId, "pipe_b");
  // Bounded by the pipeline as well as the tenant: b2 has no pipeline restriction
  // to fail, so this is B's pipe_b deals only.
  assert.equal(row.opportunityCount, 2);
});

test("a snapshot cannot be scoped to another workspace's pipeline", async () => {
  await assert.rejects(() => snapshotAs(TENANT_A, { pipelineId: "pipe_b" }), /Pipeline not found/);
});

/* ── MUTATION: the same code, the same fixture, one predicate removed ──────── */

test("MUTATION — removing the tenant predicate merges both workspaces into the total", async () => {
  const scoped = await snapshotAs(TENANT_A);
  assert.equal(scoped.summary.openValueCents, 38_000_000);

  dropTenantPredicate = true;
  try {
    const merged = await snapshotAs(TENANT_A);
    // THE DEFECT, reproduced: tenant A's snapshot row, tenant A's stamp, and every
    // workspace's money inside it.
    assert.equal(merged.summary.openValueCents, EVERYONE_OPEN);
    assert.equal(merged.summary.openValueCents, 209_499_900);
    assert.equal(merged.summary.count, 6);
    assert.equal(merged.row.tenantId, TENANT_A, "stamped A, containing everyone — why it looks correct");
    assert.equal(merged.row.openValueCents, BigInt(EVERYONE_OPEN));

    // The point is not that the assertion flips, it is the SIZE of the lie: A's
    // reported pipeline is 5.5× its real one.
    assert.ok(merged.summary.openValueCents > scoped.summary.openValueCents * 5);
  } finally {
    dropTenantPredicate = false;
  }

  // …and the harness recovers, so a green run after this one means something.
  const again = await snapshotAs(TENANT_A);
  assert.equal(again.summary.openValueCents, 38_000_000);
});

/* ── the siblings in the same file ────────────────────────────────────────── */

test("the predicate handed to the two out-of-file statements binds the acting workspace", async () => {
  // The audit `before` read (src/app/actions/pipelines.ts) and the snapshot-history
  // query (/forecast/page.tsx) cannot be executed here — one is `use server`, the
  // other a React server component. What CAN be executed is the thing they were
  // given instead of the empty scope they had, under each alias they use.
  for (const [alias, pattern] of [
    ['"tenantId"', /AND "tenantId" = \?/],
    ['fs."tenantId"', /AND fs\."tenantId" = \?/],
  ] as const) {
    for (const tenant of [TENANT_A, TENANT_B]) {
      acting = tenant;
      const fragment = await pipelines.pipelineTenantFilter(alias);
      assert.match(fragment.strings.join("?"), pattern);
      assert.deepEqual(fragment.values, [tenant], "the predicate binds the acting tenant and nothing else");
      assert.doesNotMatch(fragment.strings.join("?"), /IS NULL/, "no unowned-row escape hatch");
    }
  }
});

test("the audit `before` read cannot reach another workspace's lead", async () => {
  // The statement itself lives in the action; its BOUNDARY is exercised here by
  // running the same predicate over the same fixture the aggregate uses.
  acting = TENANT_A;
  const scope = await pipelines.pipelineTenantFilter();
  const read = async (id: string) => (await basePrisma.$queryRaw`
    SELECT "probability" FROM "Lead" WHERE "id" = ${id} AND "deletedAt" IS NULL ${scope} LIMIT 1
  ` as LeadRow[])[0] ?? null;

  assert.equal((await read("a1"))?.probability, 60);
  // Not "returns a row with someone else's teamId" — returns NOTHING, so the
  // caller refuses before either the permission decision or the audit copy.
  assert.equal(await read("b1"), null);
  assert.equal(await read("u1"), null, "an unowned lead is nobody's");
});

test("the forecast write reaches only the acting workspace's lead", async () => {
  acting = TENANT_A;
  updated.length = 0;
  await pipelines.updateLeadForecast("b1", { probability: 99, forecastCategory: "commit" });
  assert.deepEqual(updated, [], "an UPDATE by id alone rewrites another workspace's deal");

  await pipelines.updateLeadForecast("a1", { probability: 99, forecastCategory: "commit" });
  assert.deepEqual(updated, ["a1"]);
});

test("a lead cannot be attached to another workspace's team", async () => {
  acting = TENANT_A;
  await assert.rejects(
    () => pipelines.updateLeadForecast("a1", { probability: 50, forecastCategory: "commit", teamId: "team_b" }),
    /Selected team is not active/,
  );
  updated.length = 0;
  await pipelines.updateLeadForecast("a1", { probability: 50, forecastCategory: "commit", teamId: "team_a" });
  assert.deepEqual(updated, ["a1"]);
});

/* ── no forecast statement is left leaning on a dormant scope ─────────────── */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("no forecast query is scoped by tenantFilter or writeTenantId", () => {
  const lib = strip(src("src/lib/pipelines.ts"));
  const from = lib.indexOf("export async function listForecastLeads");
  assert.ok(from > 0);
  const forecast = lib.slice(from);

  // `tenantFilter` is Prisma.empty while dormant and `writeTenantId()` is null;
  // both are correct only BEHIND an already-scoped client, and every statement
  // here runs on basePrisma.
  assert.doesNotMatch(forecast, /tenantFilter\('/, "a forecast query still uses the dormant filter");
  assert.doesNotMatch(forecast, /writeTenantId\(\)/, "a forecast query still uses the dormant write scope");
  assert.match(forecast, /pipelineTenantFilter\('l\."tenantId"'\)/);
  assert.match(forecast, /pipelineScopeFilter\(actingTenant, 'l\."tenantId"'\)/);

  // The action takes the shared predicate rather than rebuilding one. The exact
  // shape that was there — `writeTenantId()` and a hand-rolled Prisma.sql, which
  // together resolve to no predicate at all while dormant — must not come back.
  const actions = strip(src("src/app/actions/pipelines.ts"));
  assert.match(actions, /const tenantScope = await pipelineTenantFilter\(\);/);
  assert.match(actions, /FROM "Lead"\s+WHERE "id" = \$\{leadId\} AND "deletedAt" IS NULL \$\{tenantScope\}/);
  assert.doesNotMatch(actions, /writeTenantId/, "the dormant write scope must not come back");
  assert.doesNotMatch(actions, /Prisma\.sql/, "the predicate must come from the one builder");
  assert.doesNotMatch(actions, /Prisma\.empty/);

  // Same for the history panel, which had no predicate at all.
  const page = strip(src("src/app/(app)/forecast/page.tsx"));
  assert.match(page, /const snapshotScope = await pipelineTenantFilter\('fs\."tenantId"'\);/);
  assert.match(page, /FROM "ForecastSnapshot" fs[\s\S]+WHERE TRUE \$\{snapshotScope\}/);
});
