import assert from "node:assert/strict";
import test from "node:test";

import {
  canChangeOwnPassword,
  canDeletePlatformAdmin,
  canDisablePlatformAdmin,
  canResetOtherPassword,
  normalisePlatformEmail,
  validPlatformPassword,
} from "../src/lib/platformAdminGuards";

const ME = "padmin_me";
const OTHER = "padmin_other";

// The rules all defend one property: the platform must never become
// unadministrable. There is no higher authority to recover it.

test("cannot disable yourself — that is a straight lockout", () => {
  const result = canDisablePlatformAdmin(ME, ME, 5);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /lock yourself out/i);
});

test("cannot disable the LAST active admin", () => {
  const result = canDisablePlatformAdmin(ME, OTHER, 0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /at least one/i);
});

test("disabling another admin is allowed while others remain active", () => {
  assert.deepEqual(canDisablePlatformAdmin(ME, OTHER, 1), { ok: true });
});

test("cannot delete yourself", () => {
  assert.equal(canDeletePlatformAdmin(ME, ME, 5).ok, false);
});

test("cannot delete the last remaining active admin", () => {
  assert.equal(canDeletePlatformAdmin(ME, OTHER, 0).ok, false);
});

test("deleting another admin is allowed while others remain", () => {
  assert.deepEqual(canDeletePlatformAdmin(ME, OTHER, 2), { ok: true });
});

test("own password change requires the CURRENT password", () => {
  // Guards against a borrowed session silently taking ownership of the account.
  const result = canChangeOwnPassword(false, "abcdefgh1234");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /current password/i);
});

test("own password change enforces the strength floor", () => {
  assert.equal(canChangeOwnPassword(true, "short1").ok, false);
  assert.equal(canChangeOwnPassword(true, "alllettersonly").ok, false);
  assert.equal(canChangeOwnPassword(true, "123456789012").ok, false);
  assert.deepEqual(canChangeOwnPassword(true, "abcdefgh1234"), { ok: true });
});

test("administrative reset refuses to target YOURSELF", () => {
  // Self-reset would bypass the current-password check above.
  const result = canResetOtherPassword(ME, ME, "abcdefgh1234");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /change-password form/i);
});

test("administrative reset of another admin needs no current password", () => {
  assert.deepEqual(canResetOtherPassword(ME, OTHER, "abcdefgh1234"), { ok: true });
});

test("administrative reset still enforces the strength floor", () => {
  assert.equal(canResetOtherPassword(ME, OTHER, "weak").ok, false);
});

test("password floor: 12+ chars with a letter and a digit", () => {
  assert.equal(validPlatformPassword("abcdefgh1234"), true);
  assert.equal(validPlatformPassword("abcdefgh123"), false, "11 chars is too short");
  assert.equal(validPlatformPassword("abcdefghijkl"), false, "no digit");
  assert.equal(validPlatformPassword("123456789012"), false, "no letter");
});

test("email is normalised and obvious rubbish rejected", () => {
  assert.equal(normalisePlatformEmail("  OPS@Example.COM "), "ops@example.com");
  assert.equal(normalisePlatformEmail(""), null);
  assert.equal(normalisePlatformEmail("not-an-email"), null);
  assert.equal(normalisePlatformEmail("no@tld"), null);
  assert.equal(normalisePlatformEmail("a@b.co"), "a@b.co");
});
