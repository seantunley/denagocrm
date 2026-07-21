import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_TENANT_ID, pickActiveTenant } from "../src/lib/tenant";

test("DEFAULT_TENANT_ID matches the id seeded by the tenant-foundation migration", () => {
  assert.equal(DEFAULT_TENANT_ID, "tenant_denago_cpt");
});

test("pickActiveTenant fails CLOSED — no memberships means no tenant (null), never a default", () => {
  assert.equal(pickActiveTenant([]), null);
});

test("pickActiveTenant returns the earliest-joined membership", () => {
  const memberships = [
    { tenantId: "tenant_b", createdAt: new Date("2026-02-01") },
    { tenantId: "tenant_a", createdAt: new Date("2026-01-01") },
    { tenantId: "tenant_c", createdAt: new Date("2026-03-01") },
  ];
  assert.equal(pickActiveTenant(memberships), "tenant_a");
});

test("pickActiveTenant does not mutate its input", () => {
  const memberships = [
    { tenantId: "tenant_b", createdAt: new Date("2026-02-01") },
    { tenantId: "tenant_a", createdAt: new Date("2026-01-01") },
  ];
  const before = memberships.map((m) => m.tenantId);
  pickActiveTenant(memberships);
  assert.deepEqual(memberships.map((m) => m.tenantId), before);
});
