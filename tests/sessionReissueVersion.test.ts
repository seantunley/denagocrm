import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/**
 * A replacement cookie must assert the version its OWN transaction wrote.
 *
 * `createSessionCookie` re-read the row and used whatever version it found.
 * After a security change that is wrong, and the sequence that breaks it is
 * ordinary:
 *
 *   1. the security action commits, bumping the version to 5;
 *   2. an owner resets the password or revokes every session — 6 — killing every
 *      live cookie including this user's;
 *   3. this call reads 6 and mints a brand-new VALID cookie at 6.
 *
 * The older request beats the newer revocation and restores the access it
 * removed. `tests/twoFactorEnrolment.test.ts` covers the enrolment behaviour;
 * this guards the version plumbing across EVERY security action, because the
 * defect is per-call-site and one missed site is a live bypass.
 */

test("createSessionCookie can be pinned to a caller-supplied version", () => {
  const auth = read("src/lib/auth.ts");
  // The fresh read stays the default — login has nothing to pin and must get
  // the current version.
  assert.match(auth, /opts\?: \{ pwa\?: boolean; sessionVersion\?: number \}/);
  assert.match(auth, /const sessionVersion = opts\?\.sessionVersion \?\? security\.sessionVersion;/);
  // …and the pinned value is what actually reaches the token, not the re-read.
  assert.match(auth, /\{ \.\.\.user, grants, sessionVersion \},/);
  assert.doesNotMatch(
    auth,
    /signFreshSession\(\s*\{ \.\.\.user, grants, sessionVersion: security\.sessionVersion \}/,
  );
});

test("every security action that revokes sessions pins its own version", () => {
  for (const file of ["src/app/actions/security.ts", "src/app/actions/settings.ts"]) {
    const source = stripComments(read(file));
    const reissues = source.match(/await createSessionCookie\([^)]*\)/g) ?? [];
    assert.ok(reissues.length > 0, `${file} should re-issue a session`);
    for (const call of reissues) {
      // A bare createSessionCookie(user) after a bump is the defect. Every call
      // site must hand over the version its transaction produced.
      assert.match(
        call,
        /sessionVersion:/,
        `${file}: "${call}" re-reads the version instead of pinning it`,
      );
    }
  }
});

test("the version is captured from the bump, inside the transaction", () => {
  const security = stripComments(read("src/app/actions/security.ts"));
  // bumpUserSessionVersion RETURNS the new value from its own UPDATE ... RETURNING,
  // so there is no window between producing the version and capturing it.
  const captures = security.match(/revokedAt = await bumpUserSessionVersion\([^)]*, tx\)/g) ?? [];
  assert.equal(captures.length, 3, "2FA enable, 2FA disable and email-OTP must each capture");

  // saveSessionPolicy bumps EVERY user with one statement, so there is no return
  // value to capture — it reads the owner's own new version back inside the
  // same transaction instead.
  assert.match(security, /SELECT "sessionVersion" FROM "User" WHERE "id" = \$\{owner\.id\}/);

  const settings = stripComments(read("src/app/actions/settings.ts"));
  assert.equal(
    (settings.match(/const revokedAt = await bumpUserSessionVersion\(user\.id\)/g) ?? []).length,
    2,
    "both password-change paths must capture the version they produced",
  );
});
