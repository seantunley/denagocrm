import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isPlatformAdmin,
  ensurePlatformAdmin,
  canActivateTenant,
  canSuspendTenant,
  canRemoveTenantMember,
} from "../src/lib/tenantAdmin";
import { DEFAULT_TENANT_ID } from "../src/lib/tenant";

// ── Platform super-admin gate: owner-only ────────────────────────────────────

test("isPlatformAdmin: only the global owner role qualifies", () => {
  assert.equal(isPlatformAdmin("owner"), true);
  assert.equal(isPlatformAdmin("member"), false);
  assert.equal(isPlatformAdmin("admin"), false);
  assert.equal(isPlatformAdmin(null), false);
  assert.equal(isPlatformAdmin(undefined), false);
});

test("ensurePlatformAdmin: non-owners are rejected with a message, owner passes", () => {
  assert.deepEqual(ensurePlatformAdmin("owner"), { ok: true });
  const denied = ensurePlatformAdmin("member");
  assert.equal(denied.ok, false);
  assert.match((denied as { error: string }).error, /platform owners/i);
});

// ── Activation is refused while enforcement is off ───────────────────────────

test("canActivateTenant: refused when isolation enforcement is OFF", () => {
  const result = canActivateTenant(false);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /enforcement must be enabled/i);
  assert.match((result as { error: string }).error, /expose existing data/i);
});

test("canActivateTenant: allowed only when enforcement is ON", () => {
  assert.deepEqual(canActivateTenant(true), { ok: true });
});

// ── The founding tenant can never be suspended ───────────────────────────────

test("canSuspendTenant: suspending the founding tenant is refused", () => {
  const result = canSuspendTenant(DEFAULT_TENANT_ID);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /founding tenant/i);
});

test("canSuspendTenant: any other tenant may be suspended", () => {
  assert.deepEqual(canSuspendTenant("tenant_other"), { ok: true });
});

test("canSuspendTenant: honours an explicit founding-tenant id override", () => {
  assert.equal(canSuspendTenant("tenant_x", "tenant_x").ok, false);
  assert.equal(canSuspendTenant(DEFAULT_TENANT_ID, "tenant_x").ok, true);
});

// ── A tenant must always keep at least one member ────────────────────────────

test("canRemoveTenantMember: removing the last member is refused", () => {
  const result = canRemoveTenantMember(1);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /at least one member/i);
});

test("canRemoveTenantMember: an empty/impossible count is also refused (fail closed)", () => {
  assert.equal(canRemoveTenantMember(0).ok, false);
});

test("canRemoveTenantMember: allowed when more than one member remains", () => {
  assert.deepEqual(canRemoveTenantMember(2), { ok: true });
  assert.deepEqual(canRemoveTenantMember(5), { ok: true });
});
