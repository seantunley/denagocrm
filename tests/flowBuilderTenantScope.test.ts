import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideBuilderTenant, flowTenantWhere } from "../src/lib/flowTenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * The runtime resolver has scoped its BotFlow reads since #402. The BUILDER never
 * did: every editor surface addressed a flow by bare `id`, so an owner of a second
 * workspace holding a flow id could open, rewrite, rename, duplicate, publish,
 * restore, simulate or delete another tenant's live conversation graph.
 *
 * Dormancy does not excuse it. `findUnique({ where: { id } })` takes a UNIQUE
 * selector, so the db.ts guard has nowhere to add a tenant predicate — these call
 * sites stay cross-tenant after enforcement flips on, unlike an ordinary
 * `findMany` the guard narrows for free.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant_second_workspace";

// ---------------------------------------------------------------------------
// Evaluate the predicate for real, rather than asserting its source shape.
// ---------------------------------------------------------------------------

type Row = { id: string; tenantId: string | null; name: string };
type Where = ReturnType<typeof flowTenantWhere>;

/** The subset of Prisma `where` semantics these scopes actually use. */
function matches(row: Row, where: Where & { id?: string }): boolean {
  if ("id" in where && where.id !== undefined && row.id !== where.id) return false;
  if ("OR" in where) return where.OR.some((clause) => row.tenantId === clause.tenantId);
  if ("tenantId" in where) return row.tenantId === where.tenantId;
  return true;
}
const select = (rows: Row[], where: Where & { id?: string }) => rows.filter((row) => matches(row, where));

/**
 * Two workspaces, plus an UN-OWNED row.
 *
 * It is no longer called "legacy", because it cannot be: migration
 * 20260722146000_tenant_automation_isolation backfilled every BotFlow that
 * predated tenancy, so a NULL row today was written after that date by an unknown
 * workspace — possibly B's. Production holds none (PREFLIP-TENANT-AUDIT.md §1).
 */
const FLOWS: Row[] = [
  { id: "flow_a", tenantId: A, name: "Founding tenant's live flow" },
  { id: "flow_unowned", tenantId: null, name: "Written by an unknown workspace" },
  { id: "flow_b", tenantId: B, name: "Second workspace's flow" },
];

test("DORMANT enforcement, active workspace B: B sees only B", () => {
  // The defect this test exists for. writeTenantId() returns null while
  // enforcement is off — which is today — so resolving the builder tenant from it
  // alone sent EVERY request to the founding tenant, whatever workspace the
  // session was acting as. The scoping was real and pointed at the wrong tenant.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: B });
  assert.equal(tenant, B, "a dormant request must still resolve to the session's workspace");

  const visible = select(FLOWS, flowTenantWhere(tenant));
  assert.deepEqual(visible.map((f) => f.id), ["flow_b"]);

  // ...and cannot reach the founding tenant's flow by id, which is how every
  // editor surface addressed one.
  assert.deepEqual(select(FLOWS, { id: "flow_a", ...flowTenantWhere(tenant) }), []);
  assert.deepEqual(select(FLOWS, { id: "flow_unowned", ...flowTenantWhere(tenant) }), []);
  // Its own, by id, still opens.
  assert.equal(select(FLOWS, { id: "flow_b", ...flowTenantWhere(tenant) }).length, 1);
});

test("DORMANT enforcement, active workspace A: the founding tenant gets NO un-owned rows either", () => {
  // This assertion used to run the other way: the founding tenant also claimed
  // `tenantId IS NULL`, because filtering strictly would have hidden every flow an
  // existing install had. The backfill and the stamping creates between them
  // emptied that population — production holds zero un-owned BotFlow rows — so a
  // NULL row today is somebody else's, and A must not get it.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: A });
  assert.deepEqual(select(FLOWS, flowTenantWhere(tenant)).map((f) => f.id), ["flow_a"]);
});

test("a session with no tenant claim still behaves exactly as it did before tenancy", () => {
  // Sessions minted before the `tid` claim existed resolve to null.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: null });
  assert.equal(tenant, DEFAULT_TENANT_ID);
  assert.deepEqual(select(FLOWS, flowTenantWhere(tenant)).map((f) => f.id), ["flow_a"]);
});

test("the un-owned flow is reachable by NOBODY, whoever is acting", () => {
  // Stated as a property over every workspace rather than as three expected
  // lists, so a rule that quietly re-admitted NULL for anyone is caught.
  for (const acting of [A, B, "tenant_third"]) {
    const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: acting });
    for (const row of select(FLOWS, flowTenantWhere(tenant))) {
      assert.equal(row.tenantId, acting, `${acting} can reach ${row.id}, owned by ${String(row.tenantId)}`);
    }
  }
});

test("an ENFORCED scope wins over the session claim", () => {
  // Under enforcement the guard's scope is authoritative; the session claim is the
  // fallback for the rollout window, not an override.
  assert.equal(decideBuilderTenant({ enforcedTenantId: B, sessionTenantId: A }), B);
  assert.equal(decideBuilderTenant({ enforcedTenantId: A, sessionTenantId: B }), A);
});

test("a second workspace cannot publish against the founding tenant's Journey", () => {
  // The publication validator asked "is this Journey active?" with no tenant
  // predicate, so another tenant's active Journey satisfied the check and the flow
  // published cleanly. Journey.tenantId is nullable like BotFlow's, so it takes
  // the same rule — strict equality, since 20260726200000_journey_tenant_isolation
  // backfilled every legacy Journey and production holds no un-owned one.
  const JOURNEYS: Row[] = [
    { id: "j_a", tenantId: A, name: "Founding tenant's welcome journey" },
    { id: "j_b", tenantId: B, name: "Second workspace's journey" },
    { id: "j_unowned", tenantId: null, name: "Written by an unknown workspace" },
  ];
  const asB = flowTenantWhere(decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: B }));
  assert.deepEqual(select(JOURNEYS, { id: "j_a", ...asB }), [], "A's Journey must not validate for B");
  assert.equal(select(JOURNEYS, { id: "j_b", ...asB }).length, 1);
  // And the picker offers only its own, so the id cannot be chosen in the first place.
  assert.deepEqual(select(JOURNEYS, asB).map((j) => j.id), ["j_b"]);

  // The un-owned Journey validates for nobody — including the founding tenant,
  // which would otherwise let A publish a flow naming a Journey that could be B's.
  const asA = flowTenantWhere(decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: A }));
  assert.deepEqual(select(JOURNEYS, { id: "j_unowned", ...asA }), []);
  assert.deepEqual(select(JOURNEYS, { id: "j_unowned", ...asB }), []);
});

// ---------------------------------------------------------------------------
// Wiring: the decision above only matters if every call site consumes it.
// ---------------------------------------------------------------------------

/** Every file that reaches BotFlow, minus the scope module itself. */
function flowCallSites(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /botFlow\./.test(src(rel))) files.push(rel);
    }
  };
  walk("src");
  return files;
}

test("the builder tenant is never resolved from writeTenantId alone", () => {
  // writeTenantId() answers a different question — how an UNGUARDED WRITE behaves
  // during the enforcement rollout — and is null while dormant. NEITHER resolver
  // may use it alone now: the runtime one used to, on the grounds that it is
  // entered through the channel's tenant scope, but that scope bound nothing while
  // dormant so the "channel tenant" was the founding tenant for every workspace.
  // It delegates to the shared bot-conversation expression, whose middle rung is
  // the ambient scope the channel entry now actually binds.
  const scope = src("src/lib/flowScope.ts");
  assert.match(scope, /export function runtimeFlowTenantId\(\): string \{\s*return botConversationTenantId\(\);/);
  assert.doesNotMatch(scope, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, "the dormant-null fallback must not come back");
  assert.match(scope, /export async function builderTenantId\(\)/);
  // The rule moved, it did not weaken. `builderTenantId` was the first caller of
  // "the workspace this SESSION is acting as"; the record writers fixed in the
  // 2026-08-10 tenant-stamp work are the next ones, so the resolver now lives in
  // lib/actingTenant.ts and this delegates rather than keeping a second copy.
  // Both halves are asserted, so a delegation to something that does NOT consult
  // the session still fails here.
  assert.match(scope, /return actingTenantId\(\)/, "the builder must resolve through the shared acting-tenant resolver");
  const acting = src("src/lib/actingTenant.ts");
  assert.match(acting, /sessionTenantId: await getActiveTenantId\(\)/, "the builder must consult the session's workspace");
  assert.match(acting, /enforcedTenantId: writeTenantId\(\)/, "…and an enforced scope must still win");

  for (const file of flowCallSites()) {
    const code = src(file);
    if (!/botFlow\./.test(code) || file.endsWith("flowPublishing.ts")) continue;
    assert.doesNotMatch(code, /writeTenantId\(\) \?\? DEFAULT_TENANT_ID/, `${file} resolves its own tenant instead of the builder's`);
  }
});

test("publishing writes as the session's workspace, not the dormant default", () => {
  const publishing = src("src/lib/flowPublishing.ts");
  const publish = publishing.slice(
    publishing.indexOf("export async function publishFlowSnapshot"),
    publishing.indexOf("export async function getFlowPublicationMeta"),
  );
  // withTenantWrite derives its own tenantId from writeTenantId(), which is the
  // founding tenant while dormant — so publishing a second workspace's draft would
  // have stamped the version, the publication and the flow itself with tenant A.
  assert.match(publish, /const tenantId = await builderTenantId\(\);/);
  assert.doesNotMatch(publish, /withTenantWrite\(async \(tx, tenantId\)/, "the transaction must not shadow the resolved tenant");
  // The runtime resolver keeps its own identity: a webhook has no session.
  assert.match(publishing, /const tenantId = runtimeFlowTenantId\(\);/);
});

test("every Journey surface the builder touches is scoped to the same workspace", () => {
  for (const [file, why] of [
    ["src/app/(app)/bot-builder/[id]/page.tsx", "the canvas Journey picker"],
    ["src/app/actions/flowAi.ts", "the allow-list the AI drafter may use"],
    ["src/lib/flowValidationServer.ts", "the authoritative publication validator"],
  ] as const) {
    assert.match(src(file), /journey\.findMany\(\{[\s\S]{0,200}\.\.\.\(await journeyScope\(\)\)/, `${why} is unscoped`);
  }
});

test("no BotFlow access uses a method that cannot carry the tenant predicate", () => {
  // findUnique/update/delete take a unique selector. There is no `where` to spread
  // the scope into, so a call site using one is cross-tenant by construction.
  const banned = /botFlow\.(findUnique|update|delete|upsert)\(/g;
  const offenders: string[] = [];
  for (const file of flowCallSites()) {
    for (const hit of src(file).match(banned) ?? []) offenders.push(`${file}: ${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "Use findFirst/updateMany/deleteMany with the resolved scope — these cannot be scoped:\n  " + offenders.join("\n  "),
  );
});

test("every BotFlow query names the tenant it is for", () => {
  const scoped = /await flowScope\(\)|flowTenantWhere\(/;
  const unscoped: string[] = [];
  for (const file of flowCallSites()) {
    const code = src(file);
    const reads = (code.match(/botFlow\.(findFirst|findMany|count|updateMany|deleteMany|aggregate)\(/g) ?? []).length;
    if (reads && !scoped.test(code)) unscoped.push(file);
  }
  assert.deepEqual(unscoped, [], "these read or write BotFlow with no tenant scope:\n  " + unscoped.join("\n  "));
});

test("a flow is stamped with its tenant at creation, including the first-run seed", () => {
  // A NULL-tenant row is invisible the moment enforcement flips on, and it was
  // already what silently broke Publish. Both creation paths must stamp, and with
  // the workspace that is creating it.
  assert.match(src("src/app/actions/flow.ts"), /tenantId: await builderTenantId\(\)/);
  const list = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(list, /const tenantId = await builderTenantId\(\);/);
  assert.match(list, /botFlow\.create\(\{ data: \{ name, definition, active: true, tenantId \} \}\)/);
});

test("the seed decision and the list agree, or a new workspace never gets its own flow", () => {
  const list = src("src/app/(app)/bot-builder/page.tsx");
  // Scoping only the list would leave a second workspace looking at an empty page
  // while count() saw the founding tenant's flows and refused to seed it one.
  assert.match(list, /botFlow\.count\(\{ where: scope \}\)/);
  assert.match(list, /botFlow\.findMany\(\{ where: scope/);
  assert.match(src("src/app/actions/flow.ts"), /botFlow\.count\(\{ where: scope \}\)/);

  for (const page of ["[id]/page.tsx", "[id]/test/page.tsx", "[id]/blocks/page.tsx", "[id]/versions/page.tsx"]) {
    assert.match(
      src(`src/app/(app)/bot-builder/${page}`),
      /findFirst\(\{ where: \{ id, \.\.\.scope \} \}\)/,
      `${page} opens a flow by bare id`,
    );
  }
});

test("published snapshots and publications are strictly scoped, having a NOT NULL tenant", () => {
  const publishing = src("src/lib/flowPublishing.ts");
  // BotFlowVersion.tenantId and BotFlowPublication.tenantId are NOT NULL — every
  // row was written through withTenantWrite — so these take the strict filter, not
  // the legacy NULL-tolerant one BotFlow needs.
  assert.match(publishing, /botFlowVersion\.findFirst\(\{ where: \{ id: pinnedVersionId, tenantId: runtimeFlowTenantId\(\) \} \}\)/);
  assert.match(publishing, /botFlowVersion\.findFirst\(\{ where: \{ id: publication\.versionId, tenantId \} \}\)/);
  assert.match(publishing, /botFlowPublication\.findMany\(\{ where: \{ tenantId: await builderTenantId\(\) \} \}\)/);
  assert.doesNotMatch(publishing, /botFlowPublication\.findMany\(\)/);
});

test("Reset carries the same mandatory fence as Save", () => {
  const action = src("src/app/actions/flow.ts");
  const reset = action.slice(action.indexOf("export async function resetFlow"), action.indexOf("export async function renameFlow"));
  assert.match(reset, /expectedUpdatedAt: string,/, "no optional stamp to opt out with");
  assert.doesNotMatch(reset, /botFlow\.update\(/, "and no unfenced branch behind it");
});

// ---------------------------------------------------------------------------
// Lifecycle: WHEN the scope is resolved matters as much as what it resolves to.
// ---------------------------------------------------------------------------

test("ENFORCED: authentication must establish the scope before anything reads it", () => {
  // Under enforcement writeTenantId() THROWS when no scope exists yet, and the
  // staff scope is established by getCurrentUser() inside requireOwner(). So an
  // action that resolved its scope first would throw TenantScopeError before
  // requireOwner() was ever reached — every Flow Builder write dead the moment
  // isolation was switched on. Dormant mode hid it completely: writeTenantId()
  // simply returns null there.
  const order = (code: string, fn: string, next: string) => {
    const body = code.slice(code.indexOf(`export async function ${fn}`), code.indexOf(`export async function ${next}`) >>> 0 || undefined);
    const authAt = body.search(/await requireOwner\(\)/);
    const scopeAt = body.search(/await flowScope\(\)|await builderTenantId\(\)/);
    return { authAt, scopeAt, fn };
  };
  const flow = src("src/app/actions/flow.ts");
  const snippets = src("src/app/actions/flowSnippets.ts");
  const versions = src("src/app/actions/flowVersions.ts");
  const simulator = src("src/app/actions/flowSimulator.ts");
  const ai = src("src/app/actions/flowAi.ts");

  const cases: Array<[string, string, string]> = [
    [flow, "createFlow", "saveFlow"],
    [flow, "saveFlow", "resetFlow"],
    [flow, "resetFlow", "renameFlow"],
    [flow, "renameFlow", "deleteFlow"],
    [flow, "deleteFlow", "duplicateFlow"],
    [flow, "duplicateFlow", "setActiveFlow"],
    [snippets, "saveCurrentFlowAsSnippet", "insertSavedFlowSnippet"],
    [snippets, "insertSavedFlowSnippet", "deleteFlowSnippet"],
    [versions, "restoreFlowVersionToDraft", "\u0000"],
    [simulator, "simulateFlowTurn", "\u0000"],
    [ai, "generateFlowDraftAction", "\u0000"],
  ];
  for (const [code, fn, next] of cases) {
    const { authAt, scopeAt } = order(code, fn, next);
    assert.ok(authAt >= 0, `${fn} does not authenticate`);
    if (scopeAt < 0) continue; // this action does not resolve a builder scope
    assert.ok(scopeAt > authAt, `${fn} resolves the tenant scope BEFORE requireOwner establishes it`);
  }
});

test("a second workspace's first flow is the shipped default, not the founding tenant's", () => {
  // getSetting/putSetting resolve every key to the founding tenant while
  // enforcement is dormant. Once the flow list became per-workspace, a brand new
  // workspace fell into the seed branch and this read tenant A's legacy BOT_FLOW
  // graph, published it as B's, then CLEARED A's setting on the way out — a
  // cross-tenant disclosure and a destructive cross-tenant write, both created by
  // scoping only the list.
  const list = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(list, /const founding = tenantId === DEFAULT_TENANT_ID;/);
  assert.match(list, /const legacy = founding \? await getSetting\("BOT_FLOW"\) : null;/);
  // The clear is already gated on `legacy`, which is now null for anyone else.
  assert.match(list, /if \(legacy\) await putSetting\("BOT_FLOW", ""\);/);
});

test("reusable blocks are per workspace, and the founding tenant keeps its own key", () => {
  // Same dormant-mode AppSettings behaviour: one global key meant a second
  // workspace listed the founding tenant's saved blocks, could insert one into its
  // own draft, and could DELETE them.
  const store = src("src/lib/flowSnippets.ts");
  assert.match(store, /export async function flowSnippetsSettingKey\(\)/);
  assert.match(store, /tenantId === DEFAULT_TENANT_ID \? FLOW_SNIPPETS_SETTING : `\$\{FLOW_SNIPPETS_SETTING\}:\$\{tenantId\}`/);
  assert.match(store, /getSetting\(await flowSnippetsSettingKey\(\)\)/);
  // Every writer too, or a save lands in a bucket the reader never looks in.
  const actions = src("src/app/actions/flowSnippets.ts");
  assert.equal((actions.match(/putSetting\(await flowSnippetsSettingKey\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(actions, /putSetting\(FLOW_SNIPPETS_SETTING/);
});

test("the per-workspace block key is a namespace, not a rename", () => {
  // The founding tenant must keep the exact existing key, or every block saved
  // before this change disappears from the workspace that owns them.
  const store = src("src/lib/flowSnippets.ts");
  assert.match(store, /export const FLOW_SNIPPETS_SETTING = "BOT_FLOW_SNIPPETS";/);
});
