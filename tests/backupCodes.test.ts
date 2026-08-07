import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";

import { normaliseBackupCode, hashBackupCode, matchBackupCode } from "../src/lib/backupCodes";
import { generateBackupCodes } from "../src/lib/totp";

/**
 * Backup codes are the way back in when the authenticator is gone. Two of the
 * three properties below were broken in production, and both failed silently —
 * indistinguishable, from the outside, from "you typed it wrong".
 */

test("the code shown to the user is the code that works", async () => {
  // THE LIVE BUG. Codes are displayed as ABCD-EFGH. Enrolment hashed them with
  // the hyphen removed; the login stripped only whitespace. So anyone entering
  // the code exactly as displayed was rejected, and the recovery path failed in
  // the one situation it exists for.
  const [code] = generateBackupCodes(1);
  assert.match(code, /^[0-9A-F]{4}-[0-9A-F]{4}$/, "codes are displayed with a hyphen");

  const stored = JSON.stringify([await hashBackupCode(code)]);

  // Exactly as shown — the case that used to fail.
  assert.ok(await matchBackupCode(stored, code), "the code as displayed must be accepted");
  // …and the forgiving variations a person actually types.
  for (const typed of [
    code.replace("-", ""),
    code.toLowerCase(),
    ` ${code} `,
    code.replace("-", " "),
    `${code}\n`,
  ]) {
    assert.ok(await matchBackupCode(stored, typed), `must accept ${JSON.stringify(typed)}`);
  }
});

test("codes already issued to real users keep working", async () => {
  // Existing stored hashes were produced by `item.replace("-", "")` over the
  // uppercase code. The new normaliser must produce the same string, or this
  // change would silently invalidate every backup code already handed out —
  // turning a fix into a lockout.
  const [code] = generateBackupCodes(1);
  const legacyHash = await bcrypt.hash(code.replace("-", ""), 10);
  const stored = JSON.stringify([legacyHash]);
  assert.ok(await matchBackupCode(stored, code), "a pre-existing code must still verify");
});

test("a wrong code matches nothing", async () => {
  const codes = generateBackupCodes(3);
  const stored = JSON.stringify(await Promise.all(codes.map(hashBackupCode)));
  for (const wrong of ["", "   ", "----", "0000-0000", "not-a-code", codes[0].slice(0, 4)]) {
    if (codes.includes(wrong)) continue;
    assert.equal(await matchBackupCode(stored, wrong), null, `${JSON.stringify(wrong)} must not match`);
  }
});

test("a used code is removed, and the others survive", async () => {
  const codes = generateBackupCodes(4);
  const hashes = await Promise.all(codes.map(hashBackupCode));
  const stored = JSON.stringify(hashes);

  const match = await matchBackupCode(stored, codes[2]);
  assert.ok(match);
  assert.equal(match.remaining.length, 3);
  assert.ok(!match.remaining.includes(hashes[2]), "the used code is gone");
  for (const index of [0, 1, 3]) {
    assert.ok(match.remaining.includes(hashes[index]), "the unused codes remain");
  }

  // The spent code no longer matches against what would be stored next.
  assert.equal(await matchBackupCode(match.remainingJson, codes[2]), null);
});

test("a corrupt or empty store is refused rather than thrown on", async () => {
  // This runs on the login path. A malformed value must not turn a sign-in
  // attempt into a 500 — and must certainly not be treated as a match.
  for (const bad of [null, undefined, "", "not json", "{}", '"a string"', "[1,2,3]", "[]"]) {
    assert.equal(await matchBackupCode(bad as string | null, "ABCD-EFGH"), null);
  }
});

test("matching does not short-circuit on the first hit", async () => {
  // Comparison time must not depend on WHICH code was supplied, or repeated
  // attempts leak the position of a valid code in the list.
  const codes = generateBackupCodes(6);
  const stored = JSON.stringify(await Promise.all(codes.map(hashBackupCode)));
  const source = readSource();
  // Asserted structurally: a `break` on match is exactly the optimisation that
  // reintroduces the timing difference.
  assert.match(source, /if \(isMatch && matchedIndex === -1\) matchedIndex = index;/);
  assert.doesNotMatch(source, /break;/, "matching must compare every candidate");
  // And it still works.
  assert.ok(await matchBackupCode(stored, codes[0]));
  assert.ok(await matchBackupCode(stored, codes[5]));
});

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return readFileSync(path.join(__dirname, "..", "src/lib/backupCodes.ts"), "utf8");
}
