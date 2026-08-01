import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decryptValue, isSecretSettingKey, storedSettingValue } from "../src/lib/settings";
import { redactUrl, REDACTED } from "../src/lib/redactUrl";
import { csvCell, csvRow } from "../src/lib/csv";

/**
 * Regression tests for three confirmed secret-handling defects:
 *
 *   1. ELEVENLABS_API_KEY was stored in AppSetting as clear text while every
 *      sibling provider key was encrypted at rest.
 *   2. instrumentation.ts persisted the full request path — capability tokens
 *      and all — into ErrorLog, which the System Log renders to owners.
 *   3. Both CSV exports emitted attacker-controlled text unescaped, so a stored
 *      `=cmd|…` ran as a formula on the reviewer's machine.
 *
 * Everything here exercises real exported functions, not source text — except a
 * handful of guards that assert the fixed CALL SITES still use those functions,
 * which is the half a pure-function test cannot cover. Every one of those goes
 * through `codeOf`, which strips comments first: without that, the comment
 * explaining a fix satisfies the very regex that is meant to be checking the
 * code. (No shared comment-stripping helper exists in tests/ on main — the
 * nearest precedents are apiAuth.test.ts, which requires a guard name to be
 * followed by `(`, and journeyBudget.test.ts, which compares indexes rather than
 * matching a window. `codeOf` is the same idea, made reusable.)
 */

const root = process.cwd();
const src = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * Source with comments removed, so an assertion can never be satisfied by the
 * prose that documents the fix. `[^:]` before `//` keeps `https://` intact.
 * String literals are deliberately KEPT: template literals carry real code in
 * their `${…}` holes, and blanking them would hide the very calls under test.
 */
function codeOf(rel: string): string {
  return src(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/* ── Finding 1: ELEVENLABS_API_KEY encrypted at rest ────────────────────── */

// A key is needed for encryptValue to actually encrypt; without one it returns
// the plaintext (and throws outright in production). 32 bytes of hex, test-only.
const TEST_KEY = "11".repeat(32);

test("ELEVENLABS_API_KEY is a credential-class setting, so writes encrypt it", () => {
  assert.equal(
    isSecretSettingKey("ELEVENLABS_API_KEY"),
    true,
    "ELEVENLABS_API_KEY must be encrypted at rest like every sibling provider key",
  );
  // Its non-secret siblings must NOT be swept in: they are read by the settings
  // page as plain values and encrypting them would be a behaviour change.
  assert.equal(isSecretSettingKey("ELEVENLABS_VOICE_ID"), false);
  assert.equal(isSecretSettingKey("ELEVENLABS_STT_MODEL"), false);
});

test("the write path stores ELEVENLABS_API_KEY as ciphertext, never as the value itself", () => {
  const before = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  try {
    const value = "elevenlabs-value-for-this-test";
    const stored = storedSettingValue("ELEVENLABS_API_KEY", value);
    assert.ok(stored.startsWith("enc:v1:"), "must be written through the AES-256-GCM envelope");
    assert.ok(!stored.includes(value), "the value must not survive anywhere in the stored column");
    assert.equal(decryptValue(stored), value, "and it must read back byte-for-byte");
  } finally {
    process.env.SETTINGS_ENCRYPTION_KEY = before;
  }
});

test("UPGRADE: a value already stored in clear text still reads correctly after the change", () => {
  const before = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  try {
    // This is the row that exists in production today: written before the key
    // was classified as secret, so it carries no `enc:v1:` prefix.
    const legacyRow = "legacy-cleartext-value";
    assert.equal(
      decryptValue(legacyRow),
      legacyRow,
      "the first read after the change must NOT attempt to decrypt a legacy row",
    );
    // ...and the next write re-encrypts it, so the upgrade completes itself.
    const rewritten = storedSettingValue("ELEVENLABS_API_KEY", decryptValue(legacyRow));
    assert.ok(rewritten.startsWith("enc:v1:"));
    assert.equal(decryptValue(rewritten), legacyRow, "lossless: clear text → ciphertext → same value");
  } finally {
    process.env.SETTINGS_ENCRYPTION_KEY = before;
  }
});

test("an empty secret stays empty rather than becoming a non-empty ciphertext", () => {
  const before = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = TEST_KEY;
  try {
    assert.equal(storedSettingValue("ELEVENLABS_API_KEY", ""), "");
  } finally {
    process.env.SETTINGS_ENCRYPTION_KEY = before;
  }
});

test("the runbook's clear-text audit covers ELEVENLABS_API_KEY, so a legacy row is reported", () => {
  // The migration is only self-completing if the operator is TOLD to re-save.
  // The runbook's "Stored credentials encrypted" check is that prompt, and it
  // only inspects the keys in its own list.
  const audited = codeOf("src/lib/securityRunbook.ts").match(/SECRET_KEYS\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(audited, "securityRunbook must still declare the audited key list");
  assert.match(
    audited[1],
    /"ELEVENLABS_API_KEY"/,
    "the 'Stored credentials encrypted' check must audit ELEVENLABS_API_KEY too",
  );
});

/* ── Finding 2: capability tokens must not reach ErrorLog ───────────────── */

// The real token shapes: SignatureRecipient/ApprovalStep are 56 hex chars,
// CampaignRecipient 36 hex, SurveyResponse a cuid. Fabricated values only.
const HEX56 = "a".repeat(56);
const HEX36 = "b".repeat(36);
const CUID = "c" + "d".repeat(24);

test("redactUrl strips the token from every token-bearing route shape", () => {
  const cases: [string, string][] = [
    [`/signing/${HEX56}`, `/signing/${REDACTED}`],
    [`/api/signing/${HEX56}`, `/api/signing/${REDACTED}`],
    [`/api/signing/${HEX56}/decline`, `/api/signing/${REDACTED}/decline`],
    [`/approvals/${HEX56}`, `/approvals/${REDACTED}`],
    [`/api/approvals/${HEX56}`, `/api/approvals/${REDACTED}`],
    [`/s/${CUID}`, `/s/${REDACTED}`],
    [`/api/track/o/${HEX36}`, `/api/track/o/${REDACTED}`],
    [`/api/unsubscribe/${HEX36}`, `/api/unsubscribe/${REDACTED}`],
    // retired scheme, still allow-listed as public and still live in old email
    [`/sign/${HEX56}`, `/sign/${REDACTED}`],
    [`/api/sign/${HEX56}`, `/api/sign/${REDACTED}`],
  ];
  for (const [input, expected] of cases) {
    const out = redactUrl(input);
    assert.equal(out, expected, `${input} must be redacted`);
    assert.ok(!out.includes(HEX56) && !out.includes(HEX36) && !out.includes(CUID));
  }
});

test("redactUrl redacts the token but keeps the non-secret query string", () => {
  const out = redactUrl(`/api/track/c/${HEX36}?u=https%3A%2F%2Fexample.com%2Fp`);
  assert.equal(out, `/api/track/c/${REDACTED}?u=https%3A%2F%2Fexample.com%2Fp`);
});

test("redactUrl redacts secret-named query parameters, including the webhook handshake", () => {
  assert.equal(
    redactUrl("/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=s3cr3t&hub.challenge=98765"),
    `/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=${REDACTED}&hub.challenge=${REDACTED}`,
  );
  assert.equal(redactUrl("/whatever?token=abc&page=2"), `/whatever?token=${REDACTED}&page=2`);
  assert.equal(redactUrl("/whatever?api_key=abc"), `/whatever?api_key=${REDACTED}`);
});

test("redactUrl works on absolute URLs and on a URL buried in an error message", () => {
  assert.equal(
    redactUrl(`https://crm.example.co.za/signing/${HEX56}`),
    `https://crm.example.co.za/signing/${REDACTED}`,
  );
  const message = `fetch failed for https://crm.example.co.za/api/approvals/${HEX56} (ECONNRESET)`;
  const out = redactUrl(message);
  assert.ok(!out.includes(HEX56), "a token quoted inside an error message must be stripped too");
  assert.ok(out.includes("ECONNRESET"), "and the rest of the message must survive");
});

test("redactUrl leaves ordinary, non-token routes completely alone", () => {
  for (const path of [
    "/api/quotes/clx123abc",
    "/leads/clx123abc?tab=notes",
    "/api/files/clx123abc",
    "/settings?tab=system",
    "/api/pdf/quote/clx123abc",
    "/portal?tab=docs",
    // In-person signing: a session-gated staff page whose last segment is a
    // plain SignatureRecipient id, NOT the token. Redacting it would be a false
    // positive — the token-prefix rules only fire at the start of a path.
    "/signatures/clx1abc/sign/clx2def",
  ]) {
    assert.equal(redactUrl(path), path, `${path} carries no credential and must not be mangled`);
  }
});

test("`/sign` must not swallow the longer `/signing` prefix", () => {
  // Regex alternation order bug guard: `/signing/x` must redact the segment
  // after `/signing/`, not leave `ing/x` behind.
  assert.equal(redactUrl("/signing/abc"), `/signing/${REDACTED}`);
});

test("the retired /sign scheme redacts its WHOLE tail, not just the next segment", () => {
  // The retired shape is `/sign/:kind/:token` — `quote` or `jobcard` first, the
  // credential SECOND. A one-segment rule here redacted `quote` and left the
  // token in the log, which is worse than not redacting at all because the line
  // then looks safe. Losing `quote`/`jobcard` from a log line costs nothing:
  // there is no src/app/sign directory, so these 404 anyway.
  for (const kind of ["quote", "jobcard"]) {
    for (const prefix of ["/sign", "/api/sign"]) {
      const out = redactUrl(`${prefix}/${kind}/${HEX56}`);
      assert.equal(out, `${prefix}/${REDACTED}`);
      assert.ok(!out.includes(HEX56), "the credential must not survive");
    }
  }
  // …and a query string still survives the tail rule
  assert.equal(redactUrl(`/sign/quote/${HEX56}?x=1`), `/sign/${REDACTED}?x=1`);
  // the staff in-person page is still untouched — the tail rule is anchored to
  // a path START, so a mid-path `/sign/` cannot trigger it
  assert.equal(redactUrl("/signatures/clx1abc/sign/clx2def"), "/signatures/clx1abc/sign/clx2def");
});

test("redactUrl handles the method-prefixed form instrumentation actually logs", () => {
  // What onRequestError builds: "<METHOD> <path?query>".
  assert.equal(redactUrl(`POST /api/signing/${HEX56}/decline`), `POST /api/signing/${REDACTED}/decline`);
  assert.equal(redactUrl(`GET /s/${CUID}`), `GET /s/${REDACTED}`);
});

test("the instrumentation hook redacts the request path before logging it", () => {
  const code = codeOf("src/instrumentation.ts");
  assert.match(
    code,
    /redactUrl\s*\(\s*request\.path\s*\)/,
    "onRequestError must pass request.path through redactUrl — it includes the query string",
  );
  assert.ok(
    !/logError\([^)]*\$\{request\.path\}/.test(code),
    "the raw request.path must never be interpolated into the logged context",
  );
});

test("logError redacts every column it persists, not just the context", () => {
  const code = codeOf("src/lib/errorLog.ts");
  assert.match(code, /const message = redactUrl\(/, "the message column must be redacted");
  assert.match(code, /redactUrl\(err\.stack\)/, "the stack column must be redacted");
  const create = code.slice(code.indexOf("errorLog.create"));
  assert.match(
    create,
    /context:\s*context\s*\?\s*redactUrl\(/,
    "the context column must be written through redactUrl",
  );
});

/* ── Finding 3: CSV formula injection ───────────────────────────────────── */

test("csvCell neutralises every formula-leading character", () => {
  const payloads = [
    "=cmd|' /C calc'!A0",
    "+1+1",
    "-2+3+cmd|' /C calc'!A0",
    "@SUM(1+1)*cmd|' /C calc'!A0",
    "\t=1+1",
    "\r=1+1",
  ];
  for (const payload of payloads) {
    const cell = csvCell(payload);
    assert.equal(cell[0], '"', "must still be a quoted field");
    assert.equal(
      cell[1],
      "'",
      `a cell opening with ${JSON.stringify(payload[0])} must be prefixed with an apostrophe: got ${cell}`,
    );
    assert.equal(cell, `"'${payload.replace(/"/g, '""')}"`);
  }
});

test("csvCell does not mangle ordinary text or real numbers", () => {
  assert.equal(csvCell("Quote accepted"), '"Quote accepted"');
  assert.equal(csvCell("-1499.00"), '"-1499.00"', "a negative amount must stay a number, not become text");
  assert.equal(csvCell("-7"), '"-7"');
  assert.equal(csvCell(42), '"42"');
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(undefined), '""');
});

test("csvCell keeps RFC 4180 quoting intact — commas, quotes, newlines", () => {
  assert.equal(csvCell('Smith, John'), '"Smith, John"');
  assert.equal(csvCell('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("carriage\rreturn"), '"carriage\rreturn"');
  // A leading CR is a formula trigger AND needs quoting; both must happen.
  assert.equal(csvCell("\rrow"), `"'\rrow"`);
});

test("csvCell renders Dates and JSON payloads the way the exports expect", () => {
  assert.equal(csvCell(new Date("2026-07-30T09:15:00.000Z")), '"2026-07-30T09:15:00.000Z"');
  assert.equal(csvCell({ status: ["open", "won"] }), '"{""status"":[""open"",""won""]}"');
});

test("csvRow renders a whole record and cannot be escaped by any one cell", () => {
  const row = csvRow(["=1+1", "Smith, John", 'He said "hi"', null]);
  assert.equal(row, `"'=1+1","Smith, John","He said ""hi""",""`);
  // Field count is stable: nothing broke out of its quotes.
  assert.equal(row.split('","').length, 4);
});

test("every CSV export in the repo writes through the shared helper", () => {
  const exports = [
    "src/app/api/audit/export/route.ts",
    "src/app/api/export/ads-conversions/route.ts",
  ];
  for (const rel of exports) {
    const code = codeOf(rel);
    assert.match(code, /text\/csv/i, `${rel} should still be a CSV export`);
    assert.match(
      code,
      /import\s*\{[^}]*csv(?:Cell|Row)[^}]*\}\s*from\s*"@\/lib\/csv"/,
      `${rel} must import csvCell/csvRow from @/lib/csv`,
    );
    assert.ok(
      /\bcsv(?:Cell|Row)\s*\(/.test(code) || /\.map\(csvCell\)/.test(code),
      `${rel} must actually call the shared helper (not merely mention it in a comment)`,
    );
    assert.ok(
      !/function\s+csv(?:Cell|Field|Escape)\s*\(/.test(code),
      `${rel} must not keep a local CSV escaper — that is how the two exports drifted apart`,
    );
  }
});
