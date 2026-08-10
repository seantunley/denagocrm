import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { flowRowVisible, flowScopeFor, flowTenantWhere } from "../src/lib/flowTenantScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * Publish was once silently dead for every flow created since the 20260722146000
 * backfill: `botFlow.create` stamped no tenant, the db.ts guard stamps nothing
 * while enforcement is dormant, and the publish transaction re-read the draft
 * with a STRICT `{ id, tenantId }` filter — found nothing, threw FLOW_NOT_FOUND,
 * and `setActiveFlow` caught that into null. The operator clicked Publish and got
 * no audit, no revalidate and no error.
 *
 * The lesson pinned here is NOT "the filter must be NULL-tolerant". It is that
 * THE READER AND THE WRITER MUST APPLY THE SAME RULE. Both now go through
 * `flowTenantWhere`, and that rule is strict equality: the creates stamp an
 * owner, the July backfill claimed the legacy rows, and production holds no
 * un-owned BotFlow at all (PREFLIP-TENANT-AUDIT.md §1).
 */

const TENANT_A = DEFAULT_TENANT_ID; // the founding workspace
const TENANT_B = "tenant_second_dealer";

type Row = { id: string; tenantId: string | null };

const FLOWS: Row[] = [
  { id: "flow_a", tenantId: TENANT_A },
  { id: "flow_b", tenantId: TENANT_B },
  { id: "flow_unowned", tenantId: null },
];

const selectAs = (tenantId: string) =>
  FLOWS.filter((row) => flowRowVisible(row.tenantId, flowScopeFor({ tenantId }))).map((r) => r.id);

test("tenant B's flow is unreachable from tenant A, and A's from B", () => {
  assert.deepEqual(selectAs(TENANT_A), ["flow_a"]);
  assert.deepEqual(selectAs(TENANT_B), ["flow_b"]);

  // The property, not just the expected list.
  for (const acting of [TENANT_A, TENANT_B, "tenant_third"]) {
    for (const id of selectAs(acting)) {
      const row = FLOWS.find((candidate) => candidate.id === id)!;
      assert.equal(row.tenantId, acting, `${acting} can reach ${id}, owned by ${String(row.tenantId)}`);
    }
  }
  assert.deepEqual(selectAs("tenant_third"), []);
});

test("an un-owned flow belongs to NOBODY — the founding tenant included", () => {
  // A NULL BotFlow.tenantId today cannot be legacy data: migration
  // 20260722146000_tenant_automation_isolation backfilled every one of them, and
  // both create sites now stamp `await builderTenantId()`. So such a row was
  // written after the backfill by an unknown workspace — quite possibly tenant
  // B's — and this predicate governs a DEACTIVATE sweep as well as reads.
  assert.equal(flowRowVisible(null, flowScopeFor({ tenantId: TENANT_A })), false);
  assert.equal(flowRowVisible(null, flowScopeFor({ tenantId: TENANT_B })), false);
  assert.equal(flowScopeFor({ tenantId: TENANT_A }).includeUnowned, false);

  const founding = flowTenantWhere(TENANT_A) as { tenantId?: string; OR?: unknown[] };
  assert.equal(founding.tenantId, TENANT_A);
  assert.equal(founding.OR, undefined, "the founding tenant must not claim the tenantless rows");

  const second = flowTenantWhere(TENANT_B) as { tenantId?: string; OR?: unknown[] };
  assert.equal(second.tenantId, TENANT_B);
  assert.equal(second.OR, undefined, "a second workspace must never inherit the tenantless rows");

  // The `where` fragment and the in-memory decision are the same rule: an OR that
  // matches NULL appears if and ONLY if the scope admits un-owned rows, so
  // reinstating the fallback in one and not the other is not expressible.
  assert.equal(flowRowVisible(null, { tenantId: TENANT_A, includeUnowned: true }), true);
});

test("the founding tenant is not a special case at all", () => {
  // The rule this replaces branched on `tenantId === DEFAULT_TENANT_ID`. If that
  // branch ever comes back, this notices: the two scopes must differ only in the
  // tenant they name.
  const founding = flowScopeFor({ tenantId: TENANT_A });
  const second = flowScopeFor({ tenantId: TENANT_B });
  assert.equal(founding.includeUnowned, second.includeUnowned);
  assert.deepEqual({ ...founding, tenantId: "x" }, { ...second, tenantId: "x" });
  assert.ok(
    !/DEFAULT_TENANT_ID/.test(
      src("src/lib/flowTenantScope.ts").slice(
        src("src/lib/flowTenantScope.ts").indexOf("export function flowScopeFor"),
        src("src/lib/flowTenantScope.ts").indexOf("export function decideBuilderTenant"),
      ),
    ),
    "no ownership decision may branch on the founding tenant id",
  );
});

test("publish reads and writes the draft with the same rule the runtime reads it with", () => {
  const code = src("src/lib/flowPublishing.ts");
  // Bound the slice: BotFlowPublication/BotFlowVersion have a NOT NULL tenantId
  // and are filtered by their own strict predicate.
  const publish = code.slice(
    code.indexOf("export async function publishFlowSnapshot"),
    code.indexOf("export async function getFlowPublicationMeta"),
  );

  // The re-read, the deactivate sweep and the activate must ALL resolve ownership
  // through the shared rule. A hand-written predicate on any one of them is how
  // the reader and the writer drifted apart and killed the Publish button.
  const filters = publish.match(/where: \{[^}]*\btenantId\b(?!\s*:\s*null)[^}]*\}/g) ?? [];
  const offenders = filters.filter(
    (w) => !w.includes("flowTenantWhere") && !w.includes("tenantId_channel") && !w.includes("flowId"),
  );
  assert.deepEqual(offenders, [], `these publish filters resolve ownership themselves:\n  ${offenders.join("\n  ")}`);

  assert.match(publish, /flowTenantWhere\(tenantId\)/, "publish must use the shared rule");
  // And it should shrink the problem rather than perpetuate it.
  assert.match(publish, /data: \{ active: true, tenantId \}/, "publishing stamps the owner it now knows");
});

test("a newly created flow is not born tenantless", () => {
  // The root cause, and the reason the fallback could be deleted at all. If every
  // creation stamps the tenant, no new un-owned row is ever produced for a
  // compatibility rule to have to cover.
  const actions = src("src/app/actions/flow.ts");
  const creates = actions.match(/botFlow\.create\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(creates.length >= 2, `expected the create sites, found ${creates.length}`);
  for (const create of creates) {
    // The session's active workspace, not writeTenantId() — that is null while
    // enforcement is dormant, so it would stamp a second workspace's new flow
    // with the founding tenant's id.
    assert.match(create, /tenantId: await builderTenantId\(\)/, `a create still writes the wrong tenant:\n${create}`);
  }
});
