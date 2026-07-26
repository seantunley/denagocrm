import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TENANT_ID,
  resolveLoginTenant,
  decideStaffTenantScope,
} from "../src/lib/tenant";
import { suspendTenant } from "../src/lib/provisioning";

// These are PURE unit tests — no DB, no network. `tenant.ts` is dependency-free and
// `provisioning.ts` only type-imports Prisma (erased at runtime) + DEFAULT_TENANT_ID,
// so both import cleanly in node:test. `suspendTenant` is exercised against a stub
// client so no query ever runs.

type SuspendClient = Parameters<typeof suspendTenant>[0];

/** A stub prisma whose tenant.update records its calls (and never touches a DB). */
function stubSuspendClient() {
  const calls: Array<{ where: unknown; data: unknown }> = [];
  const client = {
    tenant: {
      update: async (args: { where: unknown; data: unknown }) => {
        calls.push(args);
        return {};
      },
    },
  };
  return { client: client as unknown as SuspendClient, calls };
}

// ── A. Founding tenant is unsuspendable (defence-in-depth, NOT gated on enforcement) ──

test("suspendTenant refuses the founding tenant and never touches the DB", async () => {
  const { client, calls } = stubSuspendClient();
  await assert.rejects(
    () => suspendTenant(client, DEFAULT_TENANT_ID),
    /founding tenant cannot be suspended/i,
  );
  assert.equal(calls.length, 0, "no tenant.update may run for the founding tenant");
});

test("suspendTenant allows suspending any other tenant (updates active:false)", async () => {
  const { client, calls } = stubSuspendClient();
  await suspendTenant(client, "tenant_other");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { where: { id: "tenant_other" }, data: { active: false } });
});

// ── B. resolveLoginTenant — which tenant a NEW login session is stamped with ──────

test("resolveLoginTenant returns the resolved tenant when one is present", () => {
  assert.equal(resolveLoginTenant({ tenantId: "tenant_x" }, "member", true), "tenant_x");
  assert.equal(resolveLoginTenant({ tenantId: "tenant_x" }, "owner", true), "tenant_x");
  // A resolved tenant wins even with enforcement off and any role.
  assert.equal(resolveLoginTenant({ tenantId: "tenant_x" }, "member", false), "tenant_x");
});

test("resolveLoginTenant: error + owner + enforcing → founding-tenant fallback (never locked out)", () => {
  assert.equal(resolveLoginTenant({ error: "no_tenant" }, "owner", true), DEFAULT_TENANT_ID);
  assert.equal(resolveLoginTenant({ error: "ambiguous_tenant" }, "owner", true), DEFAULT_TENANT_ID);
});

test("resolveLoginTenant: error + non-owner + enforcing → null (fail closed, unchanged)", () => {
  assert.equal(resolveLoginTenant({ error: "no_tenant" }, "member", true), null);
  assert.equal(resolveLoginTenant({ error: "ambiguous_tenant" }, "admin", true), null);
});

test("resolveLoginTenant: error + owner + NOT enforcing → null (DORMANT — no fallback off)", () => {
  // Invariant 1: with enforcement off the owner fallback must not fire, so login is
  // byte-for-byte the pre-tenancy path.
  assert.equal(resolveLoginTenant({ error: "no_tenant" }, "owner", false), null);
  assert.equal(resolveLoginTenant({ error: "ambiguous_tenant" }, "owner", false), null);
});

// ── C. decideStaffTenantScope — the request-time escape-hatch decision ────────────

test("decideStaffTenantScope: enforcing + no tenant + owner → ok, enter NO scope (escape hatch)", () => {
  const d = decideStaffTenantScope(true, null, true);
  assert.deepEqual(d, { ok: true, enterTenantId: null });
  // NO scope, and CRITICALLY never a system scope — the decision type has no system
  // field, and enterTenantId:null means "establish no scope at all".
  assert.equal(d.enterTenantId, null);
  assert.equal("system" in d, false);
});

test("decideStaffTenantScope: enforcing + no tenant + non-owner → NOT ok (fail closed)", () => {
  assert.deepEqual(decideStaffTenantScope(true, null, false), { ok: false, enterTenantId: null });
});

test("decideStaffTenantScope: enforcing + a tenant → ok, enter that tenant's scope", () => {
  // Owner-ness is irrelevant once a tenant resolves — both enter the resolved scope.
  assert.deepEqual(decideStaffTenantScope(true, "tenant_a", false), { ok: true, enterTenantId: "tenant_a" });
  assert.deepEqual(decideStaffTenantScope(true, "tenant_a", true), { ok: true, enterTenantId: "tenant_a" });
});

test("decideStaffTenantScope: NOT enforcing → ok, enter NO scope (DORMANT for every input)", () => {
  assert.deepEqual(decideStaffTenantScope(false, null, false), { ok: true, enterTenantId: null });
  assert.deepEqual(decideStaffTenantScope(false, null, true), { ok: true, enterTenantId: null });
  assert.deepEqual(decideStaffTenantScope(false, "tenant_a", false), { ok: true, enterTenantId: null });
});
