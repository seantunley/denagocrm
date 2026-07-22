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
  hasNestedRelationWrite,
} from "../src/lib/tenantGuard";
import {
  runInTenantScope,
  currentTenantScope,
  withTenant,
  withSystemScope,
  enterTenantScope,
} from "../src/lib/tenantScope";
import {
  mayRetryTenantlessSession,
  __setTenantEnforcingForTests,
} from "../src/lib/tenantEnforcement";

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

// ── hasNestedRelationWrite: the fail-closed detector ────────────────────────

test("hasNestedRelationWrite: flat scalar data → false", () => {
  assert.equal(hasNestedRelationWrite({ firstName: "x", parentId: "p", n: 1, ok: true }), false);
});

test("hasNestedRelationWrite: a nested create → true", () => {
  assert.equal(hasNestedRelationWrite({ name: "x", items: { create: [{ n: 1 }] } }), true);
});

test("hasNestedRelationWrite: a nested connect → true", () => {
  assert.equal(hasNestedRelationWrite({ parent: { connect: { id: "p" } } }), true);
});

test("hasNestedRelationWrite: connectOrCreate → true", () => {
  assert.equal(
    hasNestedRelationWrite({ tag: { connectOrCreate: { where: { id: "t" }, create: { name: "t" } } } }),
    true,
  );
});

test("hasNestedRelationWrite: a JSON column with a non-relation key → false (no false positive)", () => {
  assert.equal(hasNestedRelationWrite({ meta: { create: 1, extra: 2 } }), false);
});

test("hasNestedRelationWrite: Date / array / null values → false", () => {
  assert.equal(hasNestedRelationWrite({ when: new Date(0), tags: ["a", "b"], x: null }), false);
});

test("hasNestedRelationWrite: an array payload with a nested write in one row → true", () => {
  assert.equal(hasNestedRelationWrite([{ n: 1 }, { rel: { connect: { id: "y" } } }]), true);
});

test("hasNestedRelationWrite: non-object input → false", () => {
  assert.equal(hasNestedRelationWrite(undefined), false);
  assert.equal(hasNestedRelationWrite("x"), false);
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

test("enterTenantScope: overrides the current scope for downstream access", async () => {
  // Wrapped in a run() so the enterWith override is confined to this async
  // subtree and cannot leak into other tests.
  await runInTenantScope({ tenantId: "A", system: false }, async () => {
    enterTenantScope({ tenantId: "B", system: true });
    await Promise.resolve();
    assert.deepEqual(currentTenantScope(), { tenantId: "B", system: true });
  });
});

test("concurrent scopes stay independent (parallel requests don't cross scopes)", async () => {
  const seen: (string | null | undefined)[] = [];
  await Promise.all([
    runInTenantScope({ tenantId: "A", system: false }, async () => {
      await new Promise((r) => setTimeout(r, 5)); // yield so B interleaves
      seen.push(currentTenantScope()?.tenantId ?? null);
    }),
    runInTenantScope({ tenantId: "B", system: false }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentTenantScope()?.tenantId ?? null);
    }),
  ]);
  // Each callback observed ITS OWN tenant despite interleaving.
  assert.deepEqual([...seen].sort(), ["A", "B"]);
});

test("enterTenantScope stays isolated across concurrent contexts (the chokepoint switch)", async () => {
  // Exercises the ACTUAL enter-based pattern the chokepoints use: each request has
  // its own context (a run), then switches its scope via enterTenantScope. Two
  // interleaved requests must not cross scopes.
  const seen: (string | null | undefined)[] = [];
  await Promise.all([
    runInTenantScope({ tenantId: null, system: true }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      enterTenantScope({ tenantId: "A", system: false }); // switch to A
      await new Promise((r) => setTimeout(r, 5));
      seen.push(currentTenantScope()?.tenantId ?? null);
    }),
    runInTenantScope({ tenantId: null, system: true }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      enterTenantScope({ tenantId: "B", system: false }); // switch to B
      await new Promise((r) => setTimeout(r, 1));
      seen.push(currentTenantScope()?.tenantId ?? null);
    }),
  ]);
  assert.deepEqual([...seen].sort(), ["A", "B"]);
});

test("a confined scope returning null leaves NO scope behind (portal reject path)", async () => {
  // Mirrors getPortalContact: the module check + Contact read run inside a run(),
  // and enterTenantScope is called ONLY after success. A rejected request (module
  // off / soft-deleted / missing contact) returns null and the scope must revert.
  assert.equal(currentTenantScope(), undefined); // no ambient scope
  const result = await runInTenantScope({ tenantId: "A", system: false }, async () => {
    return null as string | null; // e.g. module disabled or contact soft-deleted
  });
  assert.equal(result, null);
  assert.equal(currentTenantScope(), undefined); // scope reverted — nothing leaked
});

// ── mayRetryTenantlessSession: the login FK-race fallback decision ───────────

const fkError = { code: "P2003", meta: { constraint: "UserSession_tenantId_fkey" } };

test("mayRetryTenantlessSession: FK violation + NOT enforcing → true (backward-compat retry)", () => {
  __setTenantEnforcingForTests(false);
  try {
    assert.equal(mayRetryTenantlessSession(fkError, "tenant_x"), true);
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("mayRetryTenantlessSession: FK violation + ENFORCING → false (never issue a tenant-less session)", () => {
  __setTenantEnforcingForTests(true);
  try {
    assert.equal(mayRetryTenantlessSession(fkError, "tenant_x"), false);
  } finally {
    __setTenantEnforcingForTests(null);
  }
});

test("mayRetryTenantlessSession: a non-tenant-FK error → false regardless of mode", () => {
  __setTenantEnforcingForTests(false);
  try {
    assert.equal(mayRetryTenantlessSession({ code: "P2002" }, "tenant_x"), false);
    assert.equal(mayRetryTenantlessSession(fkError, null), false); // null tenant can't FK-fault
  } finally {
    __setTenantEnforcingForTests(null);
  }
});
