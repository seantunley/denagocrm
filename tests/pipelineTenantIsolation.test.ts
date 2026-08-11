import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  pipelineRowVisible,
  pipelineScopeFor,
  pipelineScopeSql,
  stageTenantId,
} from "../src/lib/pipelineTenantRule";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * These tests EXECUTE the ownership decision with two concrete tenant ids. The
 * sibling suite (kanbanPipelineContext) asserts that the SQL has a `${scope}` in
 * it, which is a shape check: it proves a predicate is PRESENT, not that the
 * predicate excludes anybody. A rule that resolved every caller to the founding
 * tenant would pass every one of those assertions and leak every workspace.
 *
 * `src/lib/pipelines.ts` cannot be imported here — it reaches `./db` and
 * `server-only`, which `node:test` cannot load — so the decision lives in
 * `pipelineTenantRule.ts`, which imports only the `Prisma` SQL tag.
 */

const TENANT_A = DEFAULT_TENANT_ID; // the founding workspace
const TENANT_B = "tenant_second_dealer";

type Row = { id: string; tenantId: string | null };

const TABLE: Row[] = [
  { id: "pipe_a_sales", tenantId: TENANT_A },
  { id: "pipe_a_service", tenantId: TENANT_A },
  { id: "pipe_b_sales", tenantId: TENANT_B },
  { id: "pipe_unowned", tenantId: null },
];

/** What `SELECT ... WHERE <scope>` returns, decided by the same rule the SQL encodes. */
const selectAs = (actingTenantId: string) =>
  TABLE.filter((row) => pipelineRowVisible(row.tenantId, pipelineScopeFor({ actingTenantId }))).map((r) => r.id);

/* ── the boundary, exercised rather than pattern-matched ───────────────── */

test("tenant B's pipeline is unreachable from tenant A, and A's from B", () => {
  assert.deepEqual(selectAs(TENANT_A), ["pipe_a_sales", "pipe_a_service"]);
  assert.deepEqual(selectAs(TENANT_B), ["pipe_b_sales"]);

  // Stated as the property, not just the expected list: no row a workspace does
  // not own may appear in its results, for any pair of workspaces.
  for (const acting of [TENANT_A, TENANT_B, "tenant_third"]) {
    const visible = selectAs(acting);
    for (const id of visible) {
      const row = TABLE.find((r) => r.id === id)!;
      assert.equal(row.tenantId, acting, `${acting} can reach ${id}, owned by ${String(row.tenantId)}`);
    }
  }

  // A workspace with no rows sees nothing — never "everything", which is what an
  // empty/absent predicate degrades to.
  assert.deepEqual(selectAs("tenant_third"), []);
});

test("an unowned row belongs to NOBODY — the founding tenant included", () => {
  // The rule #457 shipped was `tenantId = $1 OR tenantId IS NULL` for the founding
  // tenant. Both July backfills already claimed every legacy NULL, so a NULL row
  // today was written by the very bug being fixed and could be tenant B's.
  assert.equal(pipelineRowVisible(null, pipelineScopeFor({ actingTenantId: TENANT_A })), false);
  assert.equal(pipelineRowVisible(null, pipelineScopeFor({ actingTenantId: TENANT_B })), false);
  assert.equal(pipelineScopeFor({ actingTenantId: TENANT_A }).includeUnowned, false);
  assert.ok(!selectAs(TENANT_A).includes("pipe_unowned"));
});

test("the SQL the database runs is the rule, not a paraphrase of it", () => {
  const sqlOf = (actingTenantId: string) => {
    const q = pipelineScopeSql(pipelineScopeFor({ actingTenantId }));
    return { text: q.strings.join("?"), values: q.values };
  };

  const a = sqlOf(TENANT_A);
  assert.deepEqual(a.values, [TENANT_A], "the predicate binds the acting tenant and nothing else");
  assert.doesNotMatch(a.text, /IS NULL/, "no unowned-row escape hatch reaches the database");
  assert.match(a.text, /AND "tenantId" = \?/);

  const b = sqlOf(TENANT_B);
  assert.deepEqual(b.values, [TENANT_B]);
  assert.notDeepEqual(a.values, b.values, "two workspaces must not produce the same predicate");

  // The aliased form used by the archive join must be the same decision.
  const joined = pipelineScopeSql(pipelineScopeFor({ actingTenantId: TENANT_B }), 'p."tenantId"');
  assert.deepEqual(joined.values, [TENANT_B]);
  assert.match(joined.strings.join("?"), /AND p\."tenantId" = \?/);
  assert.doesNotMatch(joined.strings.join("?"), /IS NULL/);

  // And the SQL must agree with the in-memory reference for every scope: an
  // `IS NULL` term in the text exists if and only if the rule admits unowned rows.
  for (const acting of [TENANT_A, TENANT_B]) {
    const scope = pipelineScopeFor({ actingTenantId: acting });
    const emitted = /IS NULL/.test(pipelineScopeSql(scope).strings.join("?"));
    assert.equal(emitted, scope.includeUnowned, "the SQL and the rule disagree about unowned rows");
    assert.equal(pipelineRowVisible(null, scope), emitted);
  }

  // The column is SPLICED (Prisma.raw), the tenant is BOUND. Never the other way
  // round: a bound identifier would not filter, and a spliced tenant id would be
  // an injection point on a value that decides who sees what.
  assert.ok(!joined.values.some((v) => String(v).includes("tenantId")));
  assert.equal(joined.values.length, 1);
});

/* ── a stage belongs to its pipeline, not to whoever is editing ────────── */

test("a stage inherits its PIPELINE's owner, never the editor's", () => {
  // The case that separates the two answers: an operator whose acting workspace
  // is the founding tenant, editing a pipeline owned by tenant B.
  assert.equal(
    stageTenantId({ pipelineTenantId: TENANT_B, actingTenantId: TENANT_A }),
    TENANT_B,
    "the stage would have been split off from its own pipeline",
  );
  assert.equal(stageTenantId({ pipelineTenantId: TENANT_A, actingTenantId: TENANT_B }), TENANT_A);

  // The ordinary case still has to work, and must not be the dormant NULL that
  // `writeTenantId()` returns — that is the defect this replaces.
  assert.equal(stageTenantId({ pipelineTenantId: TENANT_A, actingTenantId: TENANT_A }), TENANT_A);
  assert.notEqual(stageTenantId({ pipelineTenantId: TENANT_A, actingTenantId: TENANT_A }), null);

  // A stage is only ever as owned as its parent: the caller resolves the parent
  // through the scoped read first, so this can never invent an owner.
  assert.equal(stageTenantId({ pipelineTenantId: null, actingTenantId: TENANT_A }), null);
});

test("a stage is visible to exactly the workspace its pipeline belongs to", () => {
  // Compose the two rules the way the runtime does: stamp from the parent, then
  // read back through the scope. Tenant A must not see a stage of B's pipeline.
  const stamped = stageTenantId({ pipelineTenantId: TENANT_B, actingTenantId: TENANT_A });
  assert.equal(pipelineRowVisible(stamped, pipelineScopeFor({ actingTenantId: TENANT_A })), false);
  assert.equal(pipelineRowVisible(stamped, pipelineScopeFor({ actingTenantId: TENANT_B })), true);
});

/* ── the wiring, because a correct rule nobody calls fixes nothing ─────── */

test("pipelines.ts builds its predicate from the rule and holds no second copy", () => {
  const lib = strip(src("src/lib/pipelines.ts"));
  const filter = lib.slice(lib.indexOf("async function pipelineTenantFilter"), lib.indexOf("export type OwnedPipeline"));
  // ONE construction of the predicate, from the shared rule. The async seam
  // resolves the principal and hands it to the synchronous builder; callers that
  // already hold a resolved owner call the builder directly.
  assert.match(filter, /pipelineScopeSql\(pipelineScopeFor\(\{ actingTenantId: tenantId \}\), alias\)/);
  assert.match(filter, /return pipelineScopeFilter\(await actingTenantId\(\), alias\)/);
  assert.equal(
    (filter.match(/pipelineScopeSql\(/g) ?? []).length,
    1,
    "the predicate must be built in exactly one place",
  );
  // No hand-rolled predicate may survive beside the shared one.
  assert.doesNotMatch(filter, /Prisma\.sql/, "the SQL must come from pipelineScopeSql");
  assert.doesNotMatch(lib, /IS NULL\)`/, "the unowned-row fallback must not be reintroduced");
  assert.doesNotMatch(lib, /DEFAULT_TENANT_ID/, "ownership is the acting tenant, not the founding one");
});

test("no pipeline operation resolves the acting tenant twice", () => {
  /*
   * `actingTenantId()` is a SECURITY PRINCIPAL. Every function here that needs it
   * as a value — to stamp a new row, to derive a stage's owner — used to resolve
   * it once for that value and then call `pipelineTenantFilter()`, which resolved
   * it a second time to build the SQL scope.
   *
   * It is unlikely to change inside one request, and there is no benefit to
   * asking twice: at best the second read is wasted, and if the two ever
   * disagreed the row would be stamped with one tenant while the statement that
   * writes it is scoped to another. These run on `basePrisma` — the RLS bypass —
   * so nothing downstream would catch the split.
   *
   * The insert value and the SQL scope must come from ONE resolution, threaded.
   */
  const lib = strip(src("src/lib/pipelines.ts"));
  // `to` omitted means "to the end of the file" — captureForecastSnapshot is last.
  const bodies = (from: string, to?: string) =>
    lib.slice(lib.indexOf(from), to === undefined ? undefined : lib.indexOf(to));

  const operations: Array<[string, string?]> = [
    ["export async function createPipeline", "export async function updatePipeline"],
    ["export async function addPipelineStage", "export async function updatePipelineStage"],
    ["export async function updatePipelineStage", "export async function reorderPipelineStages"],
    ["export async function archivePipeline", "export async function listForecastLeads"],
    // The forecast write: one resolution bounds BOTH the team it may attach and
    // the lead it may reach. Two could disagree, and there is no guard behind
    // basePrisma to notice a lead scoped to one workspace taking another's team.
    ["export async function updateLeadForecast", "export async function captureForecastSnapshot"],
    ["export async function captureForecastSnapshot"],
  ];
  for (const [from, to] of operations) {
    assert.ok(lib.includes(from), `${from} must be locatable`);
    if (to !== undefined) {
      assert.ok(lib.indexOf(to) > lib.indexOf(from), `${to} must follow ${from}`);
    }
    const body = bodies(from, to);
    assert.ok(body.length > 0, `${from} must have a body`);
    const resolves = (body.match(/await actingTenantId\(\)/g) ?? []).length;
    assert.equal(resolves, 1, `${from} resolves the acting tenant ${resolves} times, expected exactly 1`);
    // A second resolution also hides inside the async seam, so these must take
    // the predicate from the synchronous builder or from the gate they pass it to.
    assert.doesNotMatch(
      body,
      /await pipelineTenantFilter\(/,
      `${from} re-resolves the principal through pipelineTenantFilter`,
    );
  }
});

test("every PipelineStage write resolves its parent through the tenant boundary", () => {
  const lib = strip(src("src/lib/pipelines.ts"));
  const slice = (from: string, to: string) => lib.slice(lib.indexOf(from), lib.indexOf(to));

  // The gate may be handed the caller's already-resolved owner, so the id is
  // asserted as the FIRST argument rather than the only one.
  const add = slice("export async function addPipelineStage", "export async function updatePipelineStage");
  assert.match(add, /await requireOwnedPipeline\(input\.pipelineId[,)]/);
  assert.match(add, /stageTenantId\(\{ pipelineTenantId: pipeline\.tenantId/, "the stamp is the parent's owner");
  assert.doesNotMatch(add, /const tenantId = writeTenantId\(\)/, "writeTenantId is null while dormant");
  assert.match(add, /INSERT INTO "PipelineStage" \([\s\S]*"tenantId"/, "the insert stamps it");

  const update = slice("export async function updatePipelineStage", "export async function reorderPipelineStages");
  assert.match(update, /await requireOwnedPipeline\(current\[0\]\.pipelineId[,)]/);
  assert.match(update, /"tenantId" = \$\{stageTenantId\(\{ pipelineTenantId: pipeline\.tenantId/);

  const reorder = slice("export async function reorderPipelineStages", "export async function archivePipeline");
  assert.match(reorder, /await requireOwnedPipeline\(pipelineId\)/);

  // requireOwnedPipeline must itself be scoped, or every caller above is theatre.
  const gate = slice("async function requireOwnedPipeline", "export async function getOwnedPipelineRow");
  assert.match(gate, /await pipelineTenantFilter\(\)/);
  assert.match(gate, /WHERE "id" = \$\{id\} AND "deletedAt" IS NULL \$\{scope\}/);
  assert.match(gate, /if \(!pipeline\) throw new Error\("Pipeline not found"\)/);
});

test("no pipeline row is loaded by id alone in the pipeline actions", () => {
  const actions = strip(src("src/app/actions/pipelines.ts"));
  // The exact shape of the two unscoped reads: a bound server-action id, straight
  // into the audit `before` snapshot, with no tenant predicate anywhere.
  assert.doesNotMatch(
    actions,
    /FROM "SalesPipeline" WHERE "id" = \$\{id\} LIMIT 1/,
    "an unscoped SELECT * lifts another workspace's row into this tenant's audit trail",
  );
  const unscoped = actions.match(/FROM "SalesPipeline"(?![\s\S]{0,200}\$\{)/g) ?? [];
  assert.deepEqual(unscoped, [], "a SalesPipeline read in the actions carries no scope");

  for (const fn of ["editSalesPipeline", "archiveSalesPipeline"]) {
    const body = actions.slice(actions.indexOf(`export async function ${fn}(`));
    assert.match(body.slice(0, 900), /const before = await getOwnedPipelineRow\(id\);/, `${fn} still reads unscoped`);
  }
  // The forecast snapshot takes a pipelineId from the same untrusted form post.
  const lib = strip(src("src/lib/pipelines.ts"));
  const capture = lib.slice(lib.indexOf("export async function captureForecastSnapshot"));
  assert.match(capture, /if \(input\.pipelineId\) await requireOwnedPipeline\(input\.pipelineId[,)]/);
  assert.match(capture, /"opportunityCount", "tenantId"/, "the snapshot must not be born unowned");
});
