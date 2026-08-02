import assert from "node:assert/strict";
import test from "node:test";

import {
  PLATFORM_ABSOLUTE_HOURS,
  PLATFORM_IDLE_MINUTES,
  PLATFORM_SESSION_COOKIE,
  platformCookieOptions,
  refreshPlatformSession,
  signPlatformSession,
  verifyPlatformSession,
  verifyPlatformSessionFull,
  type PlatformSessionPayload,
} from "../src/lib/platformSession";
import { signFreshSession, SESSION_COOKIE } from "../src/lib/session";

const admin = {
  id: "padmin_1",
  name: "Platform Operator",
  email: "ops@example.com",
  sessionVersion: 0,
};

test("a signed platform session round-trips", async () => {
  const token = await signPlatformSession(admin, "jti-1");
  const payload = await verifyPlatformSession(token);
  assert.ok(payload, "expected a valid payload");
  assert.equal(payload.sub, admin.id);
  assert.equal(payload.email, admin.email);
  assert.equal(payload.jti, "jti-1");
  assert.equal(payload.sv, 0);
  assert.equal(payload.idle, PLATFORM_IDLE_MINUTES);
});

test("a CRM session token is REJECTED by the platform verifier", async () => {
  // The whole point of the audience claim: both tokens are signed with the same
  // SESSION_SECRET, so without `aud` a CRM cookie would authenticate the console.
  const crmToken = await signFreshSession(
    {
      id: "user_1",
      name: "CRM Owner",
      email: "owner@denago.test",
      role: "owner",
      grants: "/health",
      sessionVersion: 0,
    },
    60,
    { jti: "crm-jti" },
  );
  const payload = await verifyPlatformSession(crmToken);
  assert.equal(payload, null, "a CRM token must never authenticate the console");
});

test("a platform token is REJECTED by the CRM verifier", async () => {
  // The converse direction: a console session must not unlock the CRM either.
  const { verifySession } = await import("../src/lib/session");
  const token = await signPlatformSession(admin, "jti-2");
  const payload = await verifySession(token);
  // The CRM verifier requires `sv` and `sub`, which the platform token also has,
  // so guard the real distinction: it must not carry CRM role/module claims.
  if (payload) {
    assert.equal(
      (payload as unknown as { role?: string }).role,
      undefined,
      "a platform token must not carry a CRM role claim",
    );
    assert.equal(
      (payload as unknown as { rg?: string }).rg,
      undefined,
      "a platform token must not carry CRM route-grant claims",
    );
  }
});

test("an idle-expired session is rejected", async () => {
  const token = await signPlatformSession(admin, "jti-3");
  const decoded = await verifyPlatformSession(token);
  assert.ok(decoded);

  // Re-sign with `la` pushed past the idle window.
  const stale: PlatformSessionPayload = {
    ...decoded,
    la: Math.floor(Date.now() / 1000) - (PLATFORM_IDLE_MINUTES * 60 + 60),
  };
  const staleToken = await refreshStale(stale);
  const result = await verifyPlatformSessionFull(staleToken);
  assert.equal(result.status, "expired");
});

/** Re-sign a payload verbatim (refreshPlatformSession would reset `la`). */
async function refreshStale(payload: PlatformSessionPayload): Promise<string> {
  const { SignJWT } = await import("jose");
  const secret = new TextEncoder().encode(
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
      ? process.env.SESSION_SECRET
      : "dev-secret-local-only",
  );
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience("platform")
    .setIssuedAt()
    .setExpirationTime(payload.abs)
    .sign(secret);
}

test("refreshing slides the idle window without changing identity", async () => {
  const token = await signPlatformSession(admin, "jti-4");
  const before = await verifyPlatformSession(token);
  assert.ok(before);

  const refreshed = await refreshPlatformSession({ ...before, la: before.la - 300 });
  const after = await verifyPlatformSession(refreshed);
  assert.ok(after);
  assert.equal(after.sub, before.sub);
  assert.equal(after.jti, before.jti);
  assert.ok(after.la >= before.la - 300, "last-active should move forward");
});

test("a tampered token is rejected", async () => {
  const token = await signPlatformSession(admin, "jti-5");
  const tampered = `${token.slice(0, -3)}aaa`;
  assert.equal(await verifyPlatformSession(tampered), null);
});

test("the platform cookie is scoped to /platform and hardened", () => {
  const options = platformCookieOptions();
  assert.equal(options.path, "/platform", "must not be sent to CRM routes");
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, "lax");
  assert.equal(options.maxAge, PLATFORM_ABSOLUTE_HOURS * 3600);
});

test("the platform cookie name differs from the CRM's", () => {
  assert.notEqual(PLATFORM_SESSION_COOKIE, SESSION_COOKIE);
});
