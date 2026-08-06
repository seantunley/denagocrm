import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { generateBackupCodes, generateTotpSecret, verifyTotp, totpKeyUri } from "../src/lib/totp";
import { PLATFORM_SESSION_COOKIE } from "../src/lib/platformSession";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/**
 * Two-factor authentication for the platform console.
 *
 * This account can create, brand and suspend every tenant on the platform and
 * has nobody above it — no owner to reset it, no second administrator to notice.
 * So the properties below are not defence in depth; several of them are the only
 * thing standing between a stolen password and every customer's data.
 */

// ── The second factor itself ────────────────────────────────────────────────

test("a TOTP secret verifies its own codes and rejects everything else", () => {
  const secret = generateTotpSecret();
  const step = Math.floor(Date.now() / 30_000);
  const code = totpAt(secret, step);

  assert.equal(verifyTotp(code, secret), true);
  // One step either side, because a phone's clock is never exactly ours and
  // rejecting a correct code is how somebody locks themselves out of the
  // console at the worst possible moment.
  assert.equal(verifyTotp(totpAt(secret, step - 1), secret), true);
  assert.equal(verifyTotp(totpAt(secret, step + 1), secret), true);
  // …but not an unbounded window, or a code shoulder-surfed an hour ago works.
  assert.equal(verifyTotp(totpAt(secret, step - 10), secret), false);
  assert.equal(verifyTotp(totpAt(secret, step + 10), secret), false);

  assert.equal(verifyTotp(code, generateTotpSecret()), false, "another secret's code must not pass");
  for (const junk of ["", "000000", "abcdef", "12345", "1234567", code.slice(1)]) {
    if (junk === code) continue;
    assert.equal(verifyTotp(junk, secret), false, `"${junk}" must not verify`);
  }
});

test("backup codes are unique, unguessable, and enough of them to be usable", () => {
  const codes = generateBackupCodes(8);
  assert.equal(codes.length, 8);
  assert.equal(new Set(codes).size, 8, "a repeated code silently halves the recovery set");

  // These are the ONLY way back in for an account with no owner above it, so
  // they have to be worth as much as the password they stand in for.
  for (const code of codes) {
    const entropy = code.replace(/-/g, "");
    assert.ok(entropy.length >= 8, `too short to resist guessing: ${code}`);
    assert.match(code, /^[0-9a-z-]+$/i, "must be readable off a printout without ambiguity");
  }
  // Independently generated sets must not collide.
  assert.equal(new Set([...codes, ...generateBackupCodes(8)]).size, 16);
});

test("the authenticator entry names the platform, not a tenant", () => {
  // A platform administrator is not a tenant's user. An entry labelled with a
  // customer's name would be actively misleading in the app the operator opens
  // under pressure.
  const uri = totpKeyUri(generateTotpSecret(), "ops@example.com", "Acme Platform Console");
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /issuer=Acme(%20|\+)Platform(%20|\+)Console/);
  assert.match(uri, /ops(%40|@)example\.com/);
});

// ── The login ceremony ──────────────────────────────────────────────────────

test("the half-authenticated cookie is the platform's own, never the CRM's", () => {
  const pending = read("src/lib/platformPending.ts");
  // A shared name would let a pending CRM login be finished at the platform's
  // verify step, or the reverse, decided only by which action read it first —
  // which would defeat the entire point of the console holding a separate
  // identity from any CRM account.
  assert.match(pending, /"denago_platform_2fa_pending"/);
  assert.notEqual(PLATFORM_SESSION_COOKIE, "denago_platform_2fa_pending");
  // Compared against the CRM's actual cookie, read from the CRM login action
  // where it is defined — so that renaming EITHER one and colliding is caught,
  // rather than only the platform side being pinned to a literal.
  const crmLogin = read("src/app/login/actions.ts");
  const platformName = /const PENDING_COOKIE = "([^"]+)"/.exec(pending)?.[1];
  const crmName = /const PENDING_COOKIE = "([^"]+)"/.exec(crmLogin)?.[1];
  assert.ok(platformName, "the platform flow must name its pending cookie explicitly");
  assert.ok(crmName, "the CRM flow must name its pending cookie explicitly");
  assert.notEqual(platformName, crmName, "the two pending cookies must not share a name");

  // It asserts "this password was already checked for admin X", so a guessable
  // signing key turns the second factor into the ONLY factor for anyone who can
  // set a cookie.
  assert.match(pending, /SESSION_SECRET/);
  assert.match(pending, /NODE_ENV === "production"/);
  assert.match(pending, /throw new Error\("SESSION_SECRET is not set/);

  // It carries the admin id and nothing else: it is held by someone who has
  // proved only a password, so every field in it is a field they can read.
  assert.match(pending, /SignJWT\(\{ pid: adminId \}\)/);
});

test("an enrolled admin gets no session from a correct password alone", () => {
  const actions = read("src/app/platform/login/actions.ts");
  const login = actions.slice(
    actions.indexOf("export async function platformLogin"),
    actions.indexOf("export async function platformVerifyTotp"),
  );

  // `completePlatformLogin` DOES belong in the password step — an administrator
  // who has not enrolled must still be able to sign in. What matters is the
  // order: the enrolled branch has to return before execution can reach it.
  const enrolledBranch = login.search(/if \(admin!?\.?.*totpEnabledAt/);
  const returnsPending = login.search(/return \{ need2fa: true \}/);
  const completes = login.search(/await completePlatformLogin\(/);

  assert.ok(enrolledBranch !== -1, "the password step must check whether a factor is enrolled");
  assert.ok(returnsPending !== -1, "…and stop, handing back 'now prove the second factor'");
  assert.ok(completes !== -1, "…while a non-enrolled admin still completes normally");
  assert.ok(
    enrolledBranch < returnsPending && returnsPending < completes,
    "the enrolled branch must return BEFORE any code path that issues a session",
  );

  // The pending state is issued, and nothing is recorded as a sign-in yet.
  assert.match(login, /issuePlatformPending\(/);
  // Comments are stripped first. The block above this branch EXPLAINS that
  // lastLoginAt is not stamped, so matching the raw text finds the explanation
  // and reports the very property it is describing as violated.
  const beforePending = stripComments(login.slice(0, returnsPending));
  assert.doesNotMatch(beforePending, /lastLoginAt/, "a half-authenticated attempt is not a login");
});

test("the code step is rate limited in its own right", () => {
  const actions = read("src/app/platform/login/actions.ts");
  // Without this the pending cookie is a ten-minute window in which to try a
  // million six-digit codes. Throttling only the PASSWORD step leaves that wide
  // open, because reaching the code step costs one correct password.
  assert.match(actions, /rateLimit[^\n]*platform-2fa/);
});

test("a backup code is spent before the session is issued, not after", () => {
  const actions = read("src/app/platform/login/actions.ts");
  const verify = actions.slice(actions.indexOf("export async function platformVerifyTotp"));
  const consumed = verify.search(/totpBackupCodes:\s*JSON\.stringify|remainingCodes/);
  const issued = verify.search(/completePlatformLogin\(/);
  assert.ok(consumed !== -1, "the verify step must write the remaining codes back");
  assert.ok(issued !== -1, "the verify step must issue the session");
  // If the session were issued first and the write then failed, the code would
  // stay valid — a single-use credential that survived its use.
  assert.ok(consumed < issued, "the backup code must be consumed before the session is issued");
});

test("the admin row is re-read at the second step", () => {
  const actions = read("src/app/platform/login/actions.ts");
  const verify = actions.slice(actions.indexOf("export async function platformVerifyTotp"));
  // Ten minutes is long enough to disable an account. Trusting anything cached
  // in the pending cookie would let a revoked administrator finish signing in.
  assert.match(verify, /platformAdmin\.findUnique/);
  assert.match(verify, /disabledAt|isActive|active/i);
});

// ── Turning it on and off ───────────────────────────────────────────────────

test("enabling or disabling 2FA revokes every other session", () => {
  const security = read("src/app/actions/platformSecurity.ts");
  const enables = (security.match(/sessionVersion:\s*\{\s*increment:\s*1\s*\}/g) ?? []).length;
  // Turning 2FA on is usually a response to suspecting somebody else is signed
  // in. Leaving their session alive makes the whole act ceremonial.
  assert.ok(enables >= 2, `both enable and disable must bump sessionVersion (found ${enables})`);
});

test("turning 2FA off requires the factor being turned off", () => {
  const security = read("src/app/actions/platformSecurity.ts");
  const disable = security.slice(security.indexOf("export async function disablePlatformTotp"));
  // Otherwise 2FA is removable by exactly the attacker it exists to stop:
  // someone holding a stolen password and a live session.
  assert.match(disable, /verifyTotp\(/);
  assert.match(disable, /Enter a current authenticator code/);
});

test("enrolment stores the secret disabled until a code proves it arrived", () => {
  const security = read("src/app/actions/platformSecurity.ts");
  const begin = security.slice(
    security.indexOf("export async function beginPlatformTotpEnrolment"),
    security.indexOf("export async function confirmPlatformTotpEnrolment"),
  );
  // Writing the secret and enabling it in one step locks out anyone whose scan
  // silently failed — and on this account that means losing the console with
  // nobody able to restore it.
  assert.match(begin, /totpEnabledAt:\s*null/);
  assert.match(begin, /encryptValue\(secret\)/, "the secret is encrypted at rest");
});

test("backup codes are stored hashed and shown exactly once", () => {
  const security = read("src/app/actions/platformSecurity.ts");
  assert.match(security, /bcrypt\.hash\(/);
  assert.doesNotMatch(
    security,
    /totpBackupCodes:\s*JSON\.stringify\(backupCodes\)/,
    "the plaintext codes must never be persisted",
  );
  const panel = read("src/app/platform/(console)/admins/TwoFactorPanel.tsx");
  // They cannot be recovered, so the screen has to say so at the one moment the
  // operator can still act on it.
  assert.match(panel, /not shown again/i);
});

test("the platform deliberately refuses an emailed factor", () => {
  const actions = read("src/app/platform/login/actions.ts");
  const security = read("src/app/actions/platformSecurity.ts");
  // The CRM login accepts an emailed code. Accepting one here would make the
  // highest-privilege identity on the platform exactly as strong as somebody's
  // mailbox — and mailbox access is the most common thing an attacker already
  // has by the time they are trying this.
  for (const [name, body] of [["login", actions], ["security", security]] as const) {
    assert.doesNotMatch(body, /sendEmail|emailOtp|email_otp/i, `${name} must not offer an emailed factor`);
  }
});

/** RFC 6238 reference code for a given 30-second step, to test the verifier. */
function totpAt(secret: string, step: number): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("crypto") as typeof import("crypto");
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  buf.writeUInt32BE(step >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const value = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(value % 1_000_000).padStart(6, "0");
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * Remove comments before asserting on source.
 *
 * Every assertion in this file that says "the code must NOT do X" is otherwise
 * satisfied by a comment explaining that the code does not do X — which is the
 * failure mode that made this helper necessary rather than pedantic.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
