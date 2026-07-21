import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TENANT_ID, soleActiveTenant } from "../src/lib/tenant";

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
