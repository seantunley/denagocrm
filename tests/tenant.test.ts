import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TENANT_ID,
  soleActiveTenant,
  honoredTenantClaim,
  isTenantForeignKeyViolation,
} from "../src/lib/tenant";

test("DEFAULT_TENANT_ID matches the id seeded by the tenant-foundation migration", () => {
  assert.equal(DEFAULT_TENANT_ID, "tenant_denago_cpt");
});

test("soleActiveTenant: no active membership → no_tenant (provisioning required, fail-closed)", () => {
  assert.deepEqual(soleActiveTenant([]), { error: "no_tenant" });
});

test("soleActiveTenant: exactly one active tenant → that tenant", () => {
  assert.deepEqual(soleActiveTenant(["tenant_a"]), { tenantId: "tenant_a" });
});

test("soleActiveTenant: multiple active tenants → ambiguous (needs explicit selection)", () => {
  assert.deepEqual(soleActiveTenant(["tenant_a", "tenant_b"]), { error: "ambiguous_tenant" });
});

test("soleActiveTenant dedupes repeated rows for the same tenant (not ambiguous)", () => {
  assert.deepEqual(soleActiveTenant(["tenant_a", "tenant_a"]), { tenantId: "tenant_a" });
});

test("soleActiveTenant is order-independent", () => {
  assert.deepEqual(soleActiveTenant(["tenant_b", "tenant_a"]), soleActiveTenant(["tenant_a", "tenant_b"]));
});

// ── honoredTenantClaim: which session tid claims are still safe to trust ─────

test("honoredTenantClaim: single active tenant matching the claim → honoured", () => {
  assert.equal(honoredTenantClaim("tenant_a", { tenantId: "tenant_a" }), "tenant_a");
});

test("honoredTenantClaim: no tid on the session → null", () => {
  assert.equal(honoredTenantClaim(null, { tenantId: "tenant_a" }), null);
});

test("honoredTenantClaim: membership removed / tenant suspended (now no_tenant) → null", () => {
  assert.equal(honoredTenantClaim("tenant_a", { error: "no_tenant" }), null);
});

test("honoredTenantClaim: a second membership added after login (now ambiguous) → null", () => {
  // The blocker: the claim must be REJECTED once it is no longer unambiguous.
  assert.equal(honoredTenantClaim("tenant_a", { error: "ambiguous_tenant" }), null);
});

test("honoredTenantClaim: sole active tenant differs from the claim → null", () => {
  assert.equal(honoredTenantClaim("tenant_a", { tenantId: "tenant_b" }), null);
});

// ── isTenantForeignKeyViolation: only the recoverable tenant-FK race ─────────

test("isTenantForeignKeyViolation: P2003 naming the tenant FK → true (recoverable)", () => {
  const err = { code: "P2003", meta: { field_name: "UserSession_tenantId_fkey (index)" } };
  assert.equal(isTenantForeignKeyViolation(err, "tenant_a"), true);
});

test("isTenantForeignKeyViolation: P2003 on an UNRELATED FK → false (rethrow)", () => {
  const err = { code: "P2003", meta: { field_name: "UserSession_userId_fkey (index)" } };
  assert.equal(isTenantForeignKeyViolation(err, "tenant_a"), false);
});

test("isTenantForeignKeyViolation: a non-FK Prisma error (P2002) → false (rethrow)", () => {
  assert.equal(isTenantForeignKeyViolation({ code: "P2002", meta: {} }, "tenant_a"), false);
});

test("isTenantForeignKeyViolation: no tenant was set → false (any error is unrelated)", () => {
  const err = { code: "P2003", meta: { field_name: "tenantId" } };
  assert.equal(isTenantForeignKeyViolation(err, null), false);
});

test("isTenantForeignKeyViolation: a non-Prisma error (plain/undefined) → false", () => {
  assert.equal(isTenantForeignKeyViolation(new Error("connection reset"), "tenant_a"), false);
  assert.equal(isTenantForeignKeyViolation(undefined, "tenant_a"), false);
});
