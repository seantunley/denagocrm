import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decideBuilderTenant, legacyFlowTenant } from "../src/lib/flowTenantScope";
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
type Where = ReturnType<typeof legacyFlowTenant>;

/** The subset of Prisma `where` semantics these scopes actually use. */
function matches(row: Row, where: Where & { id?: string }): boolean {
  if ("id" in where && where.id !== undefined && row.id !== where.id) return false;
  if ("OR" in where) return where.OR.some((clause) => row.tenantId === clause.tenantId);
  if ("tenantId" in where) return row.tenantId === where.tenantId;
  return true;
}
const select = (rows: Row[], where: Where & { id?: string }) => rows.filter((row) => matches(row, where));

/** Two workspaces, plus a legacy row written before anything stamped a tenant. */
const FLOWS: Row[] = [
  { id: "flow_a", tenantId: A, name: "Founding tenant's live flow" },
  { id: "flow_legacy", tenantId: null, name: "Written while the guard was dormant" },
  { id: "flow_b", tenantId: B, name: "Second workspace's flow" },
];

test("DORMANT enforcement, active workspace B: B sees only B", () => {
  // The defect this test exists for. writeTenantId() returns null while
  // enforcement is off — which is today — so resolving the builder tenant from it
  // alone sent EVERY request to the founding tenant, whatever workspace the
  // session was acting as. The scoping was real and pointed at the wrong tenant.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: B });
  assert.equal(tenant, B, "a dormant request must still resolve to the session's workspace");

  const visible = select(FLOWS, legacyFlowTenant(tenant));
  assert.deepEqual(visible.map((f) => f.id), ["flow_b"]);

  // ...and cannot reach the founding tenant's flow by id, which is how every
  // editor surface addressed one.
  assert.deepEqual(select(FLOWS, { id: "flow_a", ...legacyFlowTenant(tenant) }), []);
  assert.deepEqual(select(FLOWS, { id: "flow_legacy", ...legacyFlowTenant(tenant) }), []);
  // Its own, by id, still opens.
  assert.equal(select(FLOWS, { id: "flow_b", ...legacyFlowTenant(tenant) }).length, 1);
});

test("DORMANT enforcement, active workspace A: the founding tenant keeps the legacy rows", () => {
  // Filtering strictly would hide every flow an existing install has — which is
  // exactly how Publish came to be silently dead.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: A });
  assert.deepEqual(select(FLOWS, legacyFlowTenant(tenant)).map((f) => f.id), ["flow_a", "flow_legacy"]);
});

test("a session with no tenant claim still behaves exactly as it did before tenancy", () => {
  // Sessions minted before the `tid` claim existed resolve to null.
  const tenant = decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: null });
  assert.equal(tenant, DEFAULT_TENANT_ID);
  assert.deepEqual(select(FLOWS, legacyFlowTenant(tenant)).map((f) => f.id), ["flow_a", "flow_legacy"]);
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
  // the same legacy rule.
  const JOURNEYS: Row[] = [
    { id: "j_a", tenantId: A, name: "Founding tenant's welcome journey" },
    { id: "j_b", tenantId: B, name: "Second workspace's journey" },
  ];
  const asB = legacyFlowTenant(decideBuilderTenant({ enforcedTenantId: null, sessionTenantId: B }));
  assert.deepEqual(select(JOURNEYS, { id: "j_a", ...asB }), [], "A's Journey must not validate for B");
  assert.equal(select(JOURNEYS, { id: "j_b", ...asB }).length, 1);
  // And the picker offers only its own, so the id cannot be chosen in the first place.
  assert.deepEqual(select(JOURNEYS, asB).map((j) => j.id), ["j_b"]);
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
  // during the enforcement rollout — and is null while dormant. Only the runtime
  // resolver, which has no session and is entered through the channel's tenant
  // scope, may use it directly.
  const scope = src("src/lib/flowScope.ts");
  assert.match(scope, /export function runtimeFlowTenantId\(\): string \{\s*return writeTenantId\(\) \?\? DEFAULT_TENANT_ID;/);
  assert.match(scope, /sessionTenantId: await getActiveTenantId\(\)/, "the builder must consult the session's workspace");
  assert.match(scope, /export async function builderTenantId\(\)/);

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
  const scoped = /await flowScope\(\)|legacyFlowTenant\(/;
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
  assert.match(src("src/app/(app)/bot-builder/page.tsx"), /botFlow\.create\(\{ data: \{ name, definition, active: true, tenantId: await builderTenantId\(\) \} \}\)/);
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
