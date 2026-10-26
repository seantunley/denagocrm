import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

/**
 * Security audit 2026-10-25: every sign-in path checked the limiter first and
 * counted a failure only after verifying, so a burst of guesses sent at once all
 * passed the check before any was counted. Each path now counts the guess FIRST
 * (reserveRateLimitAttempt, one locked step) and gives it back when it is right.
 * The real-database proof — 25 at once, exactly `limit` through — is in
 * scripts/test-security.ts (CI). This pins the shape on every path.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const code = (path: string) => strip(readFileSync(path, "utf8"));

// [file, what verifies the guess] — the reservation must come before it.
const GUESS_PATHS: Array<[string, RegExp]> = [
  ["src/app/login/actions.ts", /bcrypt\.compare\(password/], // staff password
  ["src/app/login/actions.ts", /verifyTotp\(code/], // staff 2FA
  ["src/app/login/resetActions.ts", /bcrypt\.compare\(code/], // password-reset code
  ["src/app/platform/login/actions.ts", /bcrypt\.compare\(password/], // platform password
  ["src/app/platform/login/actions.ts", /verifyTotp\(code/], // platform 2FA
  ["src/app/api/auth/passkey/auth/verify/route.ts", /verifyAuthenticationResponse\(/], // passkey
  ["src/app/actions/portal.ts", /bcrypt\.compare\(code, challenge\.codeHash\)/], // portal code
];

test("every sign-in guess is counted BEFORE it is checked — no check-then-count race", () => {
  for (const [file, verifies] of GUESS_PATHS) {
    const src = code(file);
    assert.doesNotMatch(src, /checkRateLimit\s*\(/, `${file}: a read-only check can't gate a guess`);
    const at = src.search(verifies);
    assert.ok(at > 0, `${file}: verification ${verifies} not found`);
    // In the SAME function: a file with two steps (password, then 2FA) must not let
    // the first step's reservation stand in for a missing one on the second.
    const fnStart = Math.max(src.lastIndexOf("export async function", at), src.lastIndexOf("\nasync function", at));
    const reserved = src.lastIndexOf("reserveRateLimitAttempt(", at);
    assert.ok(reserved > fnStart, `${file}: the guess at ${verifies} must be reserved, in its own function, before it is checked`);
  }
});

test("a right password gives the IP's guess back; a wrong one is never counted twice", () => {
  for (const file of ["src/app/login/actions.ts", "src/app/platform/login/actions.ts"]) {
    const src = code(file);
    assert.match(src, /clearRateLimit\(accountKey\), refundRateLimitAttempt\(ipKey, LOGIN_POLICY\)/, file);
    assert.doesNotMatch(src, /registerRateLimitAttempt\((accountKey|ipKey)/, `${file}: counted once, before the check`);
  }
});

test("the limiter never answers 'allowed' because the database failed", () => {
  const src = code("src/lib/rateLimit.ts");
  const check = src.slice(src.indexOf("export async function checkRateLimit"), src.indexOf("export async function reserveRateLimitAttempt"));
  assert.doesNotMatch(check, /catch/, "checkRateLimit must not swallow a database error into 'allowed'");
  // Counting happens under the key's advisory lock, in one transaction.
  assert.match(src, /async function countAttempt[\s\S]*?pg_advisory_xact_lock/);
  assert.match(src, /export async function refundRateLimitAttempt[\s\S]*?pg_advisory_xact_lock/);
});
