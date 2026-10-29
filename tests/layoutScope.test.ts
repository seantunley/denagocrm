import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutRowVisible, layoutScopeFor, layoutScopeWhere, type LayoutScope } from "../src/lib/docbuilder/layoutScope";

/*
 * An invoice, a sales agreement and a customer statement print the workspace's
 * design and bank account, so their layouts are the acting workspace's own —
 * and a layout with no workspace is that workspace's only while it is the only
 * one there is (docs/TENANT-ENFORCEMENT-PREREQUISITES.md). The rule, executed.
 */

const A = "tenant_a";
const B = "tenant_b";

test("one workspace: its own layouts, and the ones with no workspace — every one of those is provably its", () => {
  const scope = layoutScopeFor({ tenantId: A, workspaceIds: [A] });
  assert.deepEqual(scope, { tenantId: A, includeUnowned: true });
  assert.equal(layoutRowVisible(A, scope), true);
  assert.equal(layoutRowVisible(null, scope), true);
  assert.equal(layoutRowVisible(undefined, scope), true);
  assert.equal(layoutRowVisible(B, scope), false, "a row naming another workspace is never this one's");
});

test("two or more workspaces: own layouts only — a layout with no workspace is nobody's", () => {
  for (const workspaceIds of [[A, B], [B, A], [A, B, "tenant_c"]]) {
    const scope = layoutScopeFor({ tenantId: A, workspaceIds });
    assert.deepEqual(scope, { tenantId: A, includeUnowned: false }, workspaceIds.join(","));
    assert.equal(layoutRowVisible(A, scope), true);
    assert.equal(layoutRowVisible(null, scope), false);
    assert.equal(layoutRowVisible(B, scope), false);
  }
});

test("the only workspace being some OTHER one never hands its rows to the caller", () => {
  // A stale or foreign id resolving while the table holds a single, different
  // workspace: the unowned rows are that workspace's, not the caller's.
  assert.deepEqual(layoutScopeFor({ tenantId: A, workspaceIds: [B] }), { tenantId: A, includeUnowned: false });
  assert.deepEqual(layoutScopeFor({ tenantId: A, workspaceIds: [] }), { tenantId: A, includeUnowned: false });
});

test("the query fragment is built from the scope, so the SQL cannot drift from the rule", () => {
  const sole: LayoutScope = { tenantId: A, includeUnowned: true };
  const shared: LayoutScope = { tenantId: A, includeUnowned: false };
  assert.deepEqual(layoutScopeWhere(sole), { OR: [{ tenantId: A }, { tenantId: null }] });
  assert.deepEqual(layoutScopeWhere(shared), { tenantId: A });
  // The fragment, evaluated as the database would, agrees with layoutRowVisible on every kind of row.
  const matches = (where: ReturnType<typeof layoutScopeWhere>, rowTenantId: string | null) =>
    "OR" in where ? where.OR.some((arm) => arm.tenantId === rowTenantId) : where.tenantId === rowTenantId;
  for (const scope of [sole, shared]) {
    for (const row of [A, B, null]) {
      assert.equal(matches(layoutScopeWhere(scope), row), layoutRowVisible(row, scope), `${JSON.stringify(scope)} / ${row}`);
    }
  }
});
