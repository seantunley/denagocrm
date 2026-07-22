import assert from "node:assert/strict";
import { test } from "node:test";
// Pure Phase C tenant-guard helpers. Side-effect-free (no env, no async context,
// no server-only import), so importing here is safe.
import {
  GLOBAL_MODELS,
  isTenantScopedModel,
  scopeWhere,
  stampCreate,
  scopeMutation,
  scopeUpsert,
} from "../src/lib/tenantGuard";
import {
  runInTenantScope,
  currentTenantScope,
  withTenant,
  withSystemScope,
} from "../src/lib/tenantScope";

const T = "tenant_A";

// ── the allow-list ──────────────────────────────────────────────────────────

test("GLOBAL_MODELS: auth/cross-tenant models are NOT scoped", () => {
  for (const m of ["User", "Tenant", "TenantMember", "ErrorLog", "OtpChallenge", "Passkey", "PushSubscription"]) {
    assert.equal(isTenantScopedModel(m), false, `${m} should be global`);
  }
});

test("isTenantScopedModel: business models ARE scoped (opt-out list fails safe)", () => {
  for (const m of ["Quote", "JobCard", "Product", "Campaign", "Conversation", "AppSetting", "SomeBrandNewModel"]) {
    assert.equal(isTenantScopedModel(m), true, `${m} should be tenant-scoped`);
  }
});

test("AppSetting is deliberately absent from GLOBAL_MODELS (becomes tenant-scoped)", () => {
  assert.equal(GLOBAL_MODELS.has("AppSetting"), false);
});

// ── scopeWhere: reads + single-row mutation targeting ───────────────────────

test("scopeWhere: injects tenantId into an empty where", () => {
  assert.deepEqual(scopeWhere({}, T), { where: { tenantId: T } });
});

test("scopeWhere: preserves other filters, adds tenantId", () => {
  assert.deepEqual(scopeWhere({ where: { status: "OPEN" } }, T), {
    where: { status: "OPEN", tenantId: T },
  });
});

test("scopeWhere: forces tenantId even if the caller passed a different one", () => {
  assert.deepEqual(scopeWhere({ where: { tenantId: "tenant_B" } }, T), {
    where: { tenantId: T },
  });
});

test("scopeWhere: handles undefined args", () => {
  assert.deepEqual(scopeWhere(undefined, T), { where: { tenantId: T } });
});

test("scopeWhere: does not mutate the input", () => {
  const input = { where: { status: "OPEN" } };
  scopeWhere(input, T);
  assert.deepEqual(input, { where: { status: "OPEN" } });
});

// ── stampCreate: the anti-forgery rule ──────────────────────────────────────

test("stampCreate: stamps tenantId onto a single create", () => {
  assert.deepEqual(stampCreate({ data: { name: "x" } }, T), {
    data: { name: "x", tenantId: T },
  });
});

test("stampCreate: OVERWRITES a client-supplied tenantId", () => {
  assert.deepEqual(stampCreate({ data: { name: "x", tenantId: "tenant_B" } }, T), {
    data: { name: "x", tenantId: T },
  });
});

test("stampCreate: stamps every row of a createMany array", () => {
  const out = stampCreate({ data: [{ n: 1 }, { n: 2, tenantId: "tenant_B" }] }, T);
  assert.deepEqual(out.data, [
    { n: 1, tenantId: T },
    { n: 2, tenantId: T },
  ]);
});

test("stampCreate: does not mutate the input array/objects", () => {
  const input = { data: [{ n: 1 }] };
  stampCreate(input, T);
  assert.deepEqual(input, { data: [{ n: 1 }] });
});

// ── scopeMutation: scope where + block tenant reassignment ──────────────────

test("scopeMutation: scopes the where", () => {
  assert.deepEqual(scopeMutation({ where: { id: "1" }, data: { status: "X" } }, T), {
    where: { id: "1", tenantId: T },
    data: { status: "X" },
  });
});

test("scopeMutation: forces tenantId back to context if update data tries to move the row", () => {
  const out = scopeMutation({ where: { id: "1" }, data: { tenantId: "tenant_B" } }, T);
  assert.equal(out.data.tenantId, T);
  assert.equal(out.where.tenantId, T);
});

test("scopeMutation: leaves data untouched when it has no tenantId", () => {
  const out = scopeMutation({ where: { id: "1" }, data: { status: "X" } }, T);
  assert.deepEqual(out.data, { status: "X" });
});

// ── scopeUpsert: stamp create, guard update, leave where ────────────────────

test("scopeUpsert: stamps the create branch", () => {
  const out = scopeUpsert({ where: { key: "k" }, create: { n: 1 }, update: { n: 2 } }, T);
  assert.equal(out.create.tenantId, T);
});

test("scopeUpsert: forces update.tenantId back to context when present", () => {
  const out = scopeUpsert(
    { where: { key: "k" }, create: { n: 1 }, update: { n: 2, tenantId: "tenant_B" } },
    T,
  );
  assert.equal(out.update.tenantId, T);
});

test("scopeUpsert: scopes the where so a cross-tenant upsert misses and creates instead of updating", () => {
  // Prisma 6 extendedWhereUnique: tenantId is added alongside the unique key, so
  // the lookup is confined to the caller's tenant.
  const out = scopeUpsert({ where: { key: "k" }, create: {}, update: {} }, T);
  assert.deepEqual(out.where, { key: "k", tenantId: T });
});

test("scopeUpsert: forces a caller-supplied where.tenantId back to context", () => {
  const out = scopeUpsert({ where: { key: "k", tenantId: "tenant_B" }, create: {}, update: {} }, T);
  assert.equal(out.where.tenantId, T);
});

// ── tenantScope: async-context propagation ──────────────────────────────────

test("runInTenantScope: the store is visible deep in the async subtree", async () => {
  await runInTenantScope({ tenantId: T, system: false }, async () => {
    await Promise.resolve();
    assert.deepEqual(currentTenantScope(), { tenantId: T, system: false });
  });
});

test("currentTenantScope: undefined outside any scope", () => {
  assert.equal(currentTenantScope(), undefined);
});

test("withTenant / withSystemScope: shape the scope correctly", async () => {
  await withTenant(T, async () => {
    assert.deepEqual(currentTenantScope(), { tenantId: T, system: false });
  });
  await withSystemScope(async () => {
    assert.deepEqual(currentTenantScope(), { tenantId: null, system: true });
  });
});
