import test from "node:test";
import assert from "node:assert/strict";
import { parseTenantMode, tenantEnforcing } from "../src/lib/tenantEnforcement";

test("parseTenantMode: unset/empty/unknown all fail safe to off", () => {
  assert.equal(parseTenantMode(undefined), "off");
  assert.equal(parseTenantMode(null), "off");
  assert.equal(parseTenantMode(""), "off");
  assert.equal(parseTenantMode("true"), "off");
  assert.equal(parseTenantMode("on"), "off");
  assert.equal(parseTenantMode("garbage"), "off");
});

test("parseTenantMode: recognises monitor and enforce (case/space tolerant)", () => {
  assert.equal(parseTenantMode("monitor"), "monitor");
  assert.equal(parseTenantMode("  Monitor "), "monitor");
  assert.equal(parseTenantMode("ENFORCE"), "enforce");
});

test("tenantEnforcing is always false today — 'enforce' observes only, never blocks", () => {
  // Enforcement (per-table tenantId + Postgres RLS) is a later PR. Until then even
  // TENANT_ENFORCEMENT=enforce must not block, so this hook stays false regardless.
  assert.equal(tenantEnforcing(), false);
});
