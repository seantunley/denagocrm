import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { legacyFlowTenant } from "../src/lib/flowTenantScope";
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
 * `findMany` the guard narrows for free. That is why the rule below is about the
 * METHOD, not just about today's `where` clauses.
 */

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
    "Use findFirst/updateMany/deleteMany with `...flowScope()` — these cannot be scoped:\n  " + offenders.join("\n  "),
  );
});

test("every BotFlow query names the tenant it is for", () => {
  const scoped = /flowScope\(\)|legacyFlowTenant\(/;
  const unscoped: string[] = [];
  for (const file of flowCallSites()) {
    const code = src(file);
    // `create` stamps rather than filters, and is checked separately below.
    const reads = (code.match(/botFlow\.(findFirst|findMany|count|updateMany|deleteMany|aggregate)\(/g) ?? []).length;
    if (reads && !scoped.test(code)) unscoped.push(file);
  }
  assert.deepEqual(unscoped, [], "these read or write BotFlow with no tenant scope:\n  " + unscoped.join("\n  "));
});

test("a flow is stamped with its tenant at creation, including the first-run seed", () => {
  // A NULL-tenant row is invisible the moment enforcement flips on, and it was
  // already what silently broke Publish. Both creation paths must stamp.
  const action = src("src/app/actions/flow.ts");
  assert.match(action, /tenantId: writeTenantId\(\) \?\? DEFAULT_TENANT_ID/);
  const list = src("src/app/(app)/bot-builder/page.tsx");
  assert.match(list, /botFlow\.create\(\{ data: \{ name, definition, active: true, tenantId: flowTenantId\(\) \} \}\)/);
});

test("the per-tenant reads are the ones that decide what the builder shows", () => {
  const list = src("src/app/(app)/bot-builder/page.tsx");
  // The seed decision and the list must agree, or a second tenant with no flows
  // sees the founding tenant's list and never gets its own default seeded.
  assert.match(list, /botFlow\.count\(\{ where: flowScope\(\) \}\)/);
  assert.match(list, /botFlow\.findMany\(\{ where: flowScope\(\)/);
  assert.match(src("src/app/actions/flow.ts"), /botFlow\.count\(\{ where: flowScope\(\) \}\)/);

  for (const page of ["[id]/page.tsx", "[id]/test/page.tsx", "[id]/blocks/page.tsx", "[id]/versions/page.tsx"]) {
    assert.match(
      src(`src/app/(app)/bot-builder/${page}`),
      /findFirst\(\{ where: \{ id, \.\.\.flowScope\(\) \} \}\)/,
      `${page} opens a flow by bare id`,
    );
  }
});

test("published snapshots and publications are strictly scoped, having a NOT NULL tenant", () => {
  const publishing = src("src/lib/flowPublishing.ts");
  // BotFlowVersion.tenantId and BotFlowPublication.tenantId are NOT NULL — every
  // row was written through withTenantWrite — so these take the strict filter, not
  // the legacy NULL-tolerant one BotFlow needs.
  assert.match(publishing, /botFlowVersion\.findFirst\(\{ where: \{ id: pinnedVersionId, tenantId: flowTenantId\(\) \} \}\)/);
  assert.match(publishing, /botFlowVersion\.findFirst\(\{ where: \{ id: publication\.versionId, tenantId \} \}\)/);
  assert.match(publishing, /botFlowPublication\.findMany\(\{ where: \{ tenantId: flowTenantId\(\) \} \}\)/);
  assert.doesNotMatch(publishing, /botFlowPublication\.findMany\(\)/);
});

test("the founding tenant keeps the legacy NULL rows; a second workspace does not", () => {
  // BotFlow.tenantId is still nullable and nothing stamped it while the guard was
  // dormant, so filtering strictly would hide every flow an existing install has.
  assert.deepEqual(legacyFlowTenant(DEFAULT_TENANT_ID), {
    OR: [{ tenantId: DEFAULT_TENANT_ID }, { tenantId: null }],
  });
  assert.deepEqual(legacyFlowTenant("tenant_other"), { tenantId: "tenant_other" });
});

test("Reset carries the same mandatory fence as Save, and says so when it refuses", () => {
  const action = src("src/app/actions/flow.ts");
  const reset = action.slice(action.indexOf("export async function resetFlow"), action.indexOf("export async function renameFlow"));
  assert.match(reset, /expectedUpdatedAt: string,/, "no optional stamp to opt out with");
  assert.doesNotMatch(reset, /botFlow\.update\(/, "and no unfenced branch behind it");
  // The canvas side of that refusal is modelled in full by
  // tests/flowSaveConcurrency.test.ts; here it only has to reach the server.
  assert.match(src("src/components/FlowBuilder.tsx"), /const res = await resetFlow\(flowId, savedAt\.current\);/);
});
