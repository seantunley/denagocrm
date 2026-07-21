import test from "node:test";
import assert from "node:assert/strict";
import { signFreshSession, verifySession, refreshSession } from "../src/lib/session";

const USER = { id: "u1", name: "A", email: "a@example.test", role: "owner", modules: "crm", sessionVersion: 3 };

test("session carries the tenant id (tid) claim when provided", async () => {
  const token = await signFreshSession(USER, 60, { jti: "j1", tid: "tenant_acme" });
  const payload = await verifySession(token);
  assert.ok(payload, "token should verify");
  assert.equal(payload?.tid, "tenant_acme");
  // Existing claims are untouched.
  assert.equal(payload?.sub, "u1");
  assert.equal(payload?.sv, 3);
  assert.equal(payload?.jti, "j1");
});

test("no tid claim when none is resolved (backward compatible / fail-open)", async () => {
  const token = await signFreshSession(USER, 60, { jti: "j2" });
  const payload = await verifySession(token);
  assert.ok(payload);
  assert.equal(payload?.tid, undefined, "sessions without a resolved tenant simply omit tid");
});

test("refresh preserves the tid claim", async () => {
  const token = await signFreshSession(USER, 60, { jti: "j3", tid: "tenant_acme" });
  const payload = await verifySession(token);
  assert.ok(payload);
  const refreshed = await refreshSession(payload!);
  const after = await verifySession(refreshed);
  assert.equal(after?.tid, "tenant_acme");
});
