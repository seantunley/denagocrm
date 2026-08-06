import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

/** Comments describe these properties; only code can satisfy them. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Enrolling a new authenticator must never disarm the working one.
 *
 * `disableTotp` demands a current code so that somebody holding a stolen session
 * cannot strip the second factor and keep their access after the victim rotates
 * their password. Enrolment used to overwrite `totpSecret` and clear
 * `totpEnabledAt` on its first call — the same outcome, one function over, with
 * no code required. A Server Action is a POST endpoint, so it was reachable
 * without ever loading the settings screen that renders the button.
 */

test("starting an enrolment does not touch the live factor", () => {
  const security = code(read("src/app/actions/security.ts"));
  const begin = security.slice(
    security.indexOf("export async function beginTotpEnrolment"),
    security.indexOf("export async function confirmTotpEnrolment"),
  );
  assert.ok(begin.length > 0, "beginTotpEnrolment must exist");

  // Asserted on what the function WRITES, not on every mention of a column:
  // begin legitimately READS totpSecret and totpEnabledAt to decide whether a
  // current code is required, and a blanket "must not mention" check fails on
  // that select while proving nothing about the update.
  const writes = [...begin.matchAll(/data:\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.equal(writes.length, 1, "enrolment should perform exactly one write");
  const [payload] = writes;
  assert.match(payload, /totpPendingSecret: encryptValue\(secret\)/, "the new secret goes to the pending slot");
  assert.doesNotMatch(payload, /totpEnabledAt/, "enrolment must not change whether 2FA is on");
  assert.doesNotMatch(payload, /(^|[^g])totpSecret\b/, "enrolment must not replace the live secret");
});

test("replacing an existing authenticator costs a current code", () => {
  const security = code(read("src/app/actions/security.ts"));
  const begin = security.slice(
    security.indexOf("export async function beginTotpEnrolment"),
    security.indexOf("export async function confirmTotpEnrolment"),
  );
  // Enrolling for the FIRST time must stay free — demanding a code nobody has
  // would make 2FA impossible to turn on.
  assert.match(begin, /totpEnabledAt && \w+\.totpSecret/, "the check applies only when a factor is live");
  assert.match(begin, /verifyTotp\(/);
  assert.match(begin, /throw new Error\("Enter a current authenticator code/);
});

test("confirmation verifies the pending secret, not the live one", () => {
  const security = code(read("src/app/actions/security.ts"));
  const confirm = security.slice(
    security.indexOf("export async function confirmTotpEnrolment"),
    security.indexOf("export async function disableTotp"),
  );
  // Verifying against the live secret would let a code from the authenticator
  // already in use "confirm" an enrolment that never happened.
  assert.match(confirm, /totpPendingSecret/);
  assert.match(confirm, /decryptValue\(\w+\.totpPendingSecret\)/);
  // Promotion happens only after the code passes, and clears the pending slot so
  // an abandoned enrolment cannot be confirmed later.
  assert.match(confirm, /totpSecret: encryptValue\(secret\)/);
  assert.match(confirm, /totpPendingSecret: null/);
  assert.match(confirm, /totpEnabledAt: new Date\(\)/);
});

test("disabling clears the pending secret too", () => {
  const security = code(read("src/app/actions/security.ts"));
  const disable = security.slice(security.indexOf("export async function disableTotp"));
  // Otherwise a secret staged before the disable survives it and can be
  // confirmed afterwards, quietly re-enabling a factor the user turned off.
  assert.match(disable, /totpPendingSecret: null/);
});

test("a backup code is consumed by compare-and-swap, not read-modify-write", () => {
  const login = code(read("src/app/login/actions.ts"));
  const block = login.slice(login.indexOf("matchBackupCode"), login.indexOf("if (!ok) {"));
  // Read-modify-write let two concurrent requests match the same code, write the
  // same shortened list and both receive a session — one single-use code, two
  // sign-ins. The update must be conditioned on the exact value that was read.
  assert.match(block, /updateMany\(/);
  assert.match(block, /totpBackupCodes: \w+\.totpBackupCodes/, "the update must be conditional on the prior value");
  assert.match(block, /count === 1/, "losing the race must not grant a session");
  assert.doesNotMatch(block, /codes\.splice\(/, "the spliced read-modify-write must be gone");
});

test("both flows share one definition of a backup code", () => {
  // The bug was two normalisers disagreeing. A single import on both sides is
  // what stops them drifting apart again.
  assert.match(read("src/app/login/actions.ts"), /from "@\/lib\/backupCodes"/);
  assert.match(read("src/app/actions/security.ts"), /from "@\/lib\/backupCodes"/);
  assert.doesNotMatch(
    code(read("src/app/actions/security.ts")),
    /bcrypt\.hash\(\w+\.replace\("-", ""\)/,
    "enrolment must not hash with its own private normalisation",
  );
});

test("promotion claims the pending secret it verified", () => {
  const security = code(read("src/app/actions/security.ts"));
  const confirm = security.slice(
    security.indexOf("export async function confirmTotpEnrolment"),
    security.indexOf("export async function disableTotp"),
  );
  // An unconditional update loses two races: a disable landing between the read
  // and the write is undone (2FA silently comes back on), and two confirmations
  // both issue backup codes while only the last set actually works.
  assert.match(confirm, /updateMany\(/, "promotion must be conditional");
  assert.match(confirm, /totpPendingSecret: pending\.totpPendingSecret/, "…on the value that was verified");
  assert.match(confirm, /claimed\.count !== 1/);
  assert.doesNotMatch(
    confirm,
    /tx\.user\.update\(\{\s*where: \{ id: user\.id \},\s*\n\s*data: \{\s*\n?\s*totpSecret: encryptValue/,
    "the unconditional promotion must be gone",
  );

  // …and nothing may be recorded when the claim fails.
  const claimAt = confirm.indexOf("claimed.count !== 1");
  const bumpAt = confirm.indexOf("bumpUserSessionVersion");
  const auditAt = confirm.indexOf("logAuditStrict");
  assert.ok(claimAt !== -1 && bumpAt !== -1 && auditAt !== -1);
  assert.ok(claimAt < bumpAt && claimAt < auditAt, "session bump and audit must follow a successful claim");
});

test("every path that resets 2FA clears a staged authenticator", () => {
  const security = code(read("src/app/actions/security.ts"));
  // disableTotp is not the only way 2FA gets reset. An owner reset is a second,
  // independent path, and a secret staged before it would otherwise survive and
  // be promoted afterwards — restoring access the owner had just revoked.
  for (const fn of ["disableTotp", "ownerResetUser2fa"]) {
    const start = security.indexOf(`export async function ${fn}`);
    assert.ok(start !== -1, `${fn} must exist`);
    const body = security.slice(start, start + 2000);
    assert.match(body, /totpPendingSecret: null/, `${fn} must clear the staged authenticator`);
  }
});
