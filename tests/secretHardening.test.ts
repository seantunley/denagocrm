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
  const directWebhooks = [
    "src/app/api/webhooks/meta/route.ts",
    "src/app/api/webhooks/whatsapp/route.ts",
  ];
  for (const rel of directWebhooks) {
    const code = src(rel);
    assert.match(code, /secretEquals\(/, `${rel} must compare its secret with secretEquals`);
    assert.doesNotMatch(
      code,
      /!==\s*secret\b|===\s*verifyToken\b|token\s*===\s*verifyToken/,
      `${rel} still has a short-circuiting secret comparison`,
    );
  }

  const telegramRoute = src("src/app/api/webhooks/telegram/route.ts");
  const telegramTenant = src("src/lib/telegramTenant.ts");
  assert.match(telegramRoute, /withTelegramTenantScope\(/);
  assert.match(telegramTenant, /secretEquals\(secret, expected\)/);
  assert.doesNotMatch(telegramRoute, /!==\s*secret\b|===\s*verifyToken\b|token\s*===\s*verifyToken/);
});




test("limiter rows are pruned — every key is caller-supplied", () => {
  const limiter = src("src/lib/rateLimit.ts");
  assert.match(limiter, /export async function pruneRateLimits/, "there must be a prune");
  // A row inside an active block must survive, or being blocked becomes a
  // self-clearing condition.
  assert.match(
    limiter,
    /"blockedUntil" IS NULL OR "blockedUntil" < NOW\(\)/,
    "pruning an active block would hand a blocked caller a clean slate",
  );
  // And something has to call it.
  assert.match(
    src("src/app/api/cron/automations/route.ts"),
    /pruneRateLimits\(\)/,
    "the prune must be wired into the recurring maintenance sweep",
  );
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
