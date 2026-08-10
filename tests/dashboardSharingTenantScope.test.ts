import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { sharedInTenant } from "../src/lib/dashboard/sharedScope";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * "Shared" has to mean shared INSIDE this tenant.
 *
 * Both published-dashboard reads leaned on the scoped `prisma` client for the
 * boundary, and db.ts is explicit that there isn't one:
 *
 *     if (!tenantEnforcing()) return args;   // always, today
 *
 * So a bare `sharedAt: { not: null }` matched every tenant's published
 * dashboards. Tenant A publishes "Sales"; tenant B lists it, opens it by slug,
 * and reads its title, layout, card configuration and any markdown in it.
 *
 * The previous tests were loosened from "must belong to the user" to "own OR
 * shared" — which is exactly the property that broke, so they could not catch it.
 */

const A = DEFAULT_TENANT_ID;
const B = "tenant_second_workspace";

type Row = { id: string; slug: string; userId: string; tenantId: string | null; sharedAt: Date | null };

/** The subset of Prisma `where` semantics these predicates use. */
type Where = {
  slug?: string;
  sharedAt?: { not: null };
  tenantId?: string;
  OR?: Array<{ tenantId: string | null } | { userId: string } | Where>;
};

function matches(row: Row, where: Where): boolean {
  if (where.slug !== undefined && row.slug !== where.slug) return false;
  if (where.sharedAt !== undefined && row.sharedAt === null) return false;
  if (where.tenantId !== undefined && row.tenantId !== where.tenantId) return false;
  if (where.OR) {
    return where.OR.some((clause) => {
      if ("userId" in clause) return row.userId === clause.userId;
      if ("tenantId" in clause) return row.tenantId === (clause as { tenantId: string | null }).tenantId;
      return matches(row, clause as Where);
    });
  }
  return true;
}
const select = (rows: Row[], where: Where) => rows.filter((r) => matches(r, where));

const SHARED = new Date("2026-08-01");
const ROWS: Row[] = [
  { id: "d_a", slug: "sales", userId: "u_a", tenantId: A, sharedAt: SHARED },   // A published
  { id: "d_legacy", slug: "ops", userId: "u_a", tenantId: null, sharedAt: SHARED }, // predates tenancy
  { id: "d_b", slug: "sales", userId: "u_b", tenantId: B, sharedAt: SHARED },   // B published
  { id: "d_b_own", slug: "mine", userId: "u_b", tenantId: B, sharedAt: null },  // B private
  { id: "d_a_own", slug: "secret", userId: "u_a", tenantId: A, sharedAt: null },// A private
];

test("DORMANT enforcement: B does not list A's published dashboard", () => {
  // The leak, as the switcher would have shown it.
  const listed = select(ROWS, { OR: [{ userId: "u_b" }, sharedInTenant(B)] });
  assert.deepEqual(listed.map((r) => r.id).sort(), ["d_b", "d_b_own"]);
  assert.ok(!listed.some((r) => r.id === "d_a"), "A's published dashboard must not appear for B");
  assert.ok(!listed.some((r) => r.id === "d_legacy"), "nor the founding tenant's untagged one");
});

test("DORMANT enforcement: B cannot open A's published dashboard by slug", () => {
  // Both tenants legitimately have a "sales". The slug lookup must resolve to B's.
  const opened = select(ROWS, { slug: "sales", ...sharedInTenant(B) });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].id, "d_b");

  // And a slug only A has must not resolve at all for B.
  assert.deepEqual(select(ROWS, { slug: "ops", ...sharedInTenant(B) }), []);
});

test("the founding tenant keeps the rows that predate tenancy", () => {
  // Dashboard.tenantId is nullable and nothing stamped it while the guard was
  // dormant, so a strict filter would hide existing published dashboards.
  const listed = select(ROWS, { OR: [{ userId: "u_a" }, sharedInTenant(A)] });
  assert.deepEqual(listed.map((r) => r.id).sort(), ["d_a", "d_a_own", "d_legacy"]);
});

test("private dashboards stay private in both directions", () => {
  // Sharing is what publishes; ownership is what keeps.
  assert.ok(!select(ROWS, sharedInTenant(A)).some((r) => r.id === "d_a_own"));
  assert.ok(!select(ROWS, sharedInTenant(B)).some((r) => r.id === "d_b_own"));
  // A viewer still sees their own unshared dashboard.
  assert.ok(select(ROWS, { OR: [{ userId: "u_b" }, sharedInTenant(B)] }).some((r) => r.id === "d_b_own"));
});

test("both reads name the tenant instead of assuming the client added one", () => {
  const store = src("src/lib/dashboard/store.ts");
  assert.match(store, /where: \{ OR: \[\{ userId: user\.id \}, sharedInTenant\(tenantId\)\] \}/);
  assert.match(store, /where: \{ slug: path, \.\.\.sharedInTenant\(await viewerTenantId\(\)\) \}/);
  // The defect: an unqualified shared predicate anywhere.
  const code = store.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /sharedAt: \{ not: null \}/, "a bare shared predicate matches every tenant");
});

test("the viewer's tenant is resolved, not inherited from a dormant guard", () => {
  const resolver = src("src/lib/dashboard/viewerTenant.ts");
  assert.match(resolver, /writeTenantId\(\) \?\? \(await getActiveTenantId\(\)\) \?\? DEFAULT_TENANT_ID/);
});
