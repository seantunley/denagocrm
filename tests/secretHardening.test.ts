import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { secretEquals } from "../src/lib/secretCompare";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8");

test("secretEquals accepts only an exact match", () => {
  assert.equal(secretEquals("s3cret", "s3cret"), true);
  assert.equal(secretEquals("s3cret", "s3crey"), false);
  assert.equal(secretEquals("s3cret", "s3cre"), false, "a prefix is not a match");
  assert.equal(secretEquals("s3cret", "s3crets"), false, "nor is an extension");
});

test("secretEquals fails closed on a missing value", () => {
  // The whole point: an absent header or an unconfigured secret must never
  // authenticate. `undefined === undefined` would have.
  assert.equal(secretEquals(null, "s3cret"), false);
  assert.equal(secretEquals(undefined, "s3cret"), false);
  assert.equal(secretEquals("", "s3cret"), false);
  assert.equal(secretEquals("s3cret", null), false);
  assert.equal(secretEquals("s3cret", ""), false);
  assert.equal(secretEquals(null, null), false, "two missing values are not a match");
  assert.equal(secretEquals("", ""), false);
});

test("secretEquals survives a length mismatch", () => {
  // crypto.timingSafeEqual THROWS when the buffers differ in length, so the
  // guard has to come first or an attacker crashes the route with a short header.
  assert.doesNotThrow(() => secretEquals("a", "aaaaaaaaaaaaaaaaaaaa"));
  assert.equal(secretEquals("a", "aaaaaaaaaaaaaaaaaaaa"), false);
});

test("secretEquals handles multi-byte input without throwing", () => {
  // Buffer length is BYTES, not characters — two strings of equal length in
  // characters can differ in bytes, which is exactly the throw case above.
  assert.doesNotThrow(() => secretEquals("é", "e"));
  assert.equal(secretEquals("é", "e"), false);
  assert.equal(secretEquals("é", "é"), true);
});

test("every webhook compares its secret in constant time", () => {
  const webhooks = [
    "src/app/api/webhooks/telegram/route.ts",
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/whatsapp/route.ts",
  ];
  for (const rel of webhooks) {
    const code = src(rel);
    assert.match(code, /secretEquals\(/, `${rel} must compare its secret with secretEquals`);
    assert.doesNotMatch(
      code,
      /!==\s*secret\b|===\s*verifyToken\b|token\s*===\s*verifyToken/,
      `${rel} still has a short-circuiting secret comparison`,
    );
  }
});

test("the public signing endpoints throttle before touching the database", () => {
  // A 429 is only useful if it costs less than the work it prevents. Both routes
  // must rate-limit BEFORE withTokenTenantScope, which issues the first query.
  for (const rel of [
    "src/app/api/signing/[token]/route.ts",
    "src/app/api/signing/[token]/decline/route.ts",
  ]) {
    const code = src(rel);
    const throttleAt = code.indexOf("await rateLimitSigning(");
    const scopeAt = code.indexOf("withTokenTenantScope(");
    assert.ok(throttleAt > 0, `${rel} must call rateLimitSigning`);
    assert.ok(scopeAt > 0, `${rel} must establish the tenant scope`);
    assert.ok(throttleAt < scopeAt, `${rel} must throttle before the first guarded query`);
  }
});

test("the signing throttle keys on both the token and the caller", () => {
  const code = src("src/lib/signing/throttle.ts");
  assert.match(code, /rateLimitKey\("signing-token", token\)/, "one key bounds abuse of a single link");
  assert.match(code, /rateLimitKey\("signing-ip", ip\)/, "the other bounds someone walking tokens");
  // Both must be registered even when the first already failed, or a caller
  // rotating tokens never accumulates against their address.
  const ipAt = code.indexOf('"signing-ip"');
  const tokenAt = code.indexOf('"signing-token"');
  const returnAt = code.indexOf("if (byIp.allowed && byToken.allowed) return null");
  assert.ok(ipAt < returnAt && tokenAt < returnAt, "both attempts must register before the early return");
});

// The CSP itself moved to src/lib/csp.ts + src/proxy.ts when it gained a
// per-request nonce — see tests/cspNonce.test.ts. What belongs here is only
// that the OTHER security headers survived that move.
test("next.config.ts still carries the static security headers", () => {
  const code = src("next.config.ts");
  for (const header of [
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Strict-Transport-Security",
    "Cross-Origin-Opener-Policy",
  ]) {
    assert.ok(code.includes(header), `${header} must stay in next.config.ts`);
  }
});
