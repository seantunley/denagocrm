import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { readCodeEntry, shouldAutoSubmit, type CodeEntry, type CodeEntryMode } from "../src/lib/secondFactorEntry";
import { generateBackupCodes } from "../src/lib/totp";

/**
 * Review of #937 (blocker): the two-step box sent itself at six digits, and
 * some backup codes START with six digits, so a pause while typing one sent
 * half a code. The server counts every attempt BEFORE checking it
 * (reserve-before-verify), so that burned the few attempts someone recovering
 * access has. The fix is a backup-code mode that never sends itself; these
 * tests pin it.
 */

const shipped = (rel: string) =>
  readFileSync(rel, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/**
 * Type `text` one key at a time, as a person would, and return every state the
 * box passes through. Pauses between keys change nothing: the rule has no
 * clock in it, only the mode and what is in the box.
 */
function typeInto(start: CodeEntryMode, text: string): CodeEntry[] {
  let entry: CodeEntry = { mode: start, value: "" };
  const states: CodeEntry[] = [];
  for (const key of text) {
    entry = readCodeEntry(entry.mode, entry.value + key);
    states.push(entry);
  }
  return states;
}

const sentEarly = (states: CodeEntry[]) => states.find((state) => shouldAutoSubmit(state));

test("a backup code that starts with six digits is NEVER sent by itself in backup mode, however slowly it is typed", () => {
  for (const code of ["123456AB", "1234-56AB", "12345678", "1234-5678", "987654fe", "000000AA"]) {
    const states = typeInto("backup", code);
    assert.equal(sentEarly(states), undefined, `${code} was sent by itself at ${JSON.stringify(sentEarly(states))}`);
    assert.equal(states.at(-1)?.value, code, "it arrives whole, for the person to send");
  }
});

test("no real backup code is ever sent by itself in backup mode, typed with or without its hyphen, in any case", () => {
  const codes = Array.from({ length: 250 }, () => generateBackupCodes(8)).flat(); // 2,000 codes in the real format
  for (const code of codes) {
    for (const typed of [code, code.replace("-", ""), code.toLowerCase()]) {
      assert.equal(sentEarly(typeInto("backup", typed)), undefined, `${typed} was sent by itself`);
    }
  }
});

test("backup mode never moves back to code mode by itself", () => {
  assert.deepEqual(readCodeEntry("backup", "123456"), { mode: "backup", value: "123456" });
  assert.equal(shouldAutoSubmit({ mode: "backup", value: "123456" }), false);
});

test("in the authenticator box six digits is the whole answer, and sends itself only then", () => {
  const states = typeInto("code", "123456");
  assert.deepEqual(states.map((state) => shouldAutoSubmit(state)), [false, false, false, false, false, true]);
  assert.ok(states.every((state) => state.mode === "code"));
  assert.equal(shouldAutoSubmit({ mode: "code", value: "" }), false);
  assert.equal(shouldAutoSubmit({ mode: "code", value: "12345a" }), false);
});

test("a backup code typed AS SHOWN (with its hyphen) into the authenticator box moves to backup mode before it can send", () => {
  // The hyphen is the 5th key, so the switch happens before a 6th digit exists.
  for (const code of ["1234-5678", "1234-56AB", "4F2A-9C1E"]) {
    const states = typeInto("code", code);
    assert.equal(sentEarly(states), undefined, `${code} was sent by itself`);
    assert.equal(states.at(-1)?.mode, "backup");
    assert.equal(states.at(-1)?.value, code, "what was typed is kept");
  }
  // A letter anywhere before the sixth digit does the same.
  const lettered = typeInto("code", "12A45678");
  assert.equal(sentEarly(lettered), undefined);
  assert.equal(lettered.at(-1)?.mode, "backup");
});

test("pastes: a whole backup code lands in backup mode, a spaced six-digit code is cleaned and sent", () => {
  // No maxLength of 6 on the box: a browser cuts a paste to maxLength before
  // the page sees it, which would turn a pasted all-digit backup code into six
  // digits that send themselves. Seen whole, it is a backup code.
  assert.deepEqual(readCodeEntry("code", "12345678"), { mode: "backup", value: "12345678" });
  assert.deepEqual(readCodeEntry("code", "1234-5678"), { mode: "backup", value: "1234-5678" });
  assert.deepEqual(readCodeEntry("code", " 4F2A-9C1E\n"), { mode: "backup", value: "4F2A-9C1E" });
  assert.deepEqual(readCodeEntry("code", "123 456"), { mode: "code", value: "123456" });
  assert.equal(shouldAutoSubmit(readCodeEntry("code", "123 456")), true);
  assert.equal(shouldAutoSubmit(readCodeEntry("code", "12345678")), false);
});

test("the two-step screen is wired to the rule, with no timer and no way to send twice", () => {
  const login = shipped("src/app/login/LoginClient.tsx");
  const step = login.slice(login.indexOf("function TwoFactorStep"), login.indexOf("function Shell"));
  assert.notEqual(step, "", "TwoFactorStep is gone — was it renamed?");
  assert.match(step, /onChange=\{\(event\) => setEntry\(readCodeEntry\(entry\.mode, event\.target\.value\)\)\}/);
  assert.match(
    step,
    /useEffect\(\(\) => \{\s*if \(shouldAutoSubmit\(\{ mode: entry\.mode, value: entry\.value \}\)\) submitRef\.current\?\.click\(\);\s*\}, \[entry\.mode, entry\.value\]\);/,
    "the ONLY auto-send, decided by the helper",
  );
  assert.equal([...step.matchAll(/submitRef\.current\?\.click\(\)/g)].length, 1, "nothing else sends");
  assert.match(step, /<button ref=\{submitRef\} type="submit" className="login-submit" disabled=\{pending\}>/, "clicking a disabled button does nothing");
  assert.doesNotMatch(step, /setTimeout|requestSubmit|\.submit\(\)/, "no timer and no other way to send");
  assert.doesNotMatch(step, /maxLength=\{6\}/, "see the paste test");
  assert.match(step, /Use a backup code instead/);
  assert.match(step, /setEntry\(\{ mode, value: "" \}\)/, "switching mode empties the box");
  assert.doesNotMatch(step, /Backup codes work here too/, "the old one-box invitation is gone");
});

test("the server still counts a 2FA attempt before checking it (the fix is in the page, not the limiter)", () => {
  const actions = shipped("src/app/login/actions.ts");
  const verify = actions.slice(actions.indexOf("export async function verifySecondFactor"), actions.indexOf("export async function logout"));
  const reserve = verify.indexOf("reserveRateLimitAttempt(attemptKey, OTP_VERIFY_POLICY)");
  assert.ok(reserve !== -1 && reserve < verify.indexOf('formData.get("code")'), "reserve-before-verify (#912) unchanged");
});
