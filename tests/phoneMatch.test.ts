import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { PHONE_TAIL_SQL, TAIL_LENGTH, onlyDigits, phoneTail, samePhone } from "../src/lib/phoneMatch";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/**
 * The comparison that decides whether an inbound message belongs to a customer
 * the CRM already knows, or to a stranger it should file afresh.
 */

test("the ways a South African number is actually written all reduce to one tail", () => {
  const written = [
    "+27821234567",
    "+27 82 123 4567",
    "27821234567",
    "0821234567",
    "082 123 4567",
    "082-123-4567",
    "(082) 123 4567",
    " 082 123 4567 ",
  ];
  const tails = new Set(written.map((value) => phoneTail(value)));
  assert.equal(tails.size, 1, `expected one tail, got ${[...tails].join(", ")}`);
  assert.equal([...tails][0], "821234567");
});

test("the exact pair that produced duplicate contacts now matches", () => {
  // What the CRM had stored, versus what the customer typed into the chatbot.
  assert.equal(samePhone("+27 82 123 4567", "0821234567"), true);
  assert.equal(samePhone("082 123 4567", "27821234567"), true);
});

test("different people do not match", () => {
  assert.equal(samePhone("+27821234567", "+27821234568"), false);
  assert.equal(samePhone("0821234567", "0119876543"), false);
});

test("too few digits identifies nobody, rather than everybody", () => {
  // A field holding "n/a", an extension, or a handful of digits must not become
  // a wildcard that matches every number ending the same way.
  assert.equal(phoneTail("1234"), null);
  assert.equal(phoneTail("x204"), null);
  assert.equal(phoneTail("n/a"), null);
  assert.equal(phoneTail(""), null);
  assert.equal(phoneTail(null), null);
  assert.equal(phoneTail(undefined), null);
  assert.equal(samePhone("1234", "1234"), false, "two unusable values are not a match");
});

test("a longer international number still matches on its subscriber tail", () => {
  assert.equal(samePhone("+44 20 7946 0958", "00442079460958"), true);
});

test("onlyDigits keeps digits and nothing else", () => {
  assert.equal(onlyDigits("+27 (82) 123-4567 ext 9"), "278212345679");
  assert.equal(onlyDigits(null), "");
});

// ── The SQL half ────────────────────────────────────────────────────────────

test("the SQL expression is the same rule", () => {
  const sql = PHONE_TAIL_SQL('"phone"');
  assert.match(sql, /regexp_replace/);
  assert.match(sql, /\[\^0-9\]/);
  assert.ok(sql.includes(String(TAIL_LENGTH)), "the tail length must appear in the SQL");
  assert.ok(sql.includes('coalesce("phone", \'\')'), "a NULL column must become '' rather than NULL");
});

test("MIGRATION 82 INDEXES EXACTLY THE EXPRESSION THE QUERY USES", () => {
  // Postgres matches expression indexes TEXTUALLY. One character of drift
  // between the index and the query and the index is silently ignored, turning
  // every inbound identity lookup into a sequential scan of the whole table —
  // with no error, and no symptom until the table is large.
  const migration = read("prisma/migrations/82_phone_tail_match_indexes/migration.sql");
  for (const column of ['"phone"', '"whatsapp"']) {
    assert.ok(
      migration.includes(PHONE_TAIL_SQL(column)),
      `migration 82 must index ${PHONE_TAIL_SQL(column)} verbatim`,
    );
  }
});

// ── The callers ─────────────────────────────────────────────────────────────

test("matchByPhone compares digits, not characters", () => {
  const source = read("src/lib/whatsapp.ts");
  assert.match(source, /phoneTail\(/, "the inbound lookup must normalise before comparing");
  assert.match(source, /PHONE_TAIL_SQL/, "and must use the indexed expression");
  assert.doesNotMatch(
    source,
    /phone: \{ endsWith:/,
    "endsWith needs a contiguous digit run and is what missed '082 123 4567'",
  );
});

test("the raw identity lookup names its tenant explicitly", () => {
  // Raw SQL does not go through the ORM guard, so the predicate has to be
  // written rather than assumed.
  const source = read("src/lib/whatsapp.ts");
  assert.match(source, /activeTenantPredicate\("inbound phone match"\)/);
  assert.match(source, /tenantId" IS NOT DISTINCT FROM/);
});

test("the raw identity lookup excludes soft-deleted contacts", () => {
  // basePrisma bypasses the soft-delete filter, so it must be stated.
  assert.match(read("src/lib/whatsapp.ts"), /"deletedAt" IS NULL/);
});

test("the chatbot's pre-booking lookup no longer matches on an exact string", () => {
  const source = read("src/lib/flowActions.ts");
  assert.match(source, /matchByPhone\(waDigits\(vars\.phone\)\)/, "ensureContact must use the shared matcher");
  assert.doesNotMatch(
    source,
    /findFirst\(\{ where: \{ OR: identity \} \}\)/,
    "exact-equality matching on a typed phone number is what created duplicate contacts",
  );
});

// ── Intent ──────────────────────────────────────────────────────────────────

test("AN UNKNOWN WHATSAPP NUMBER BECOMES A CONTACT, NOT A SALES LEAD", () => {
  const source = read("src/lib/whatsapp.ts");
  assert.doesNotMatch(
    source,
    /createLeadRecordIfPipelineReady/,
    "receiving a message is not evidence of sales intent — the flow's booking node decides",
  );
  assert.match(source, /prisma\.contact\.create/, "the message still needs a person to hang off");
});

test("Messenger and Instagram keep creating a lead only for ad-attributed DMs", () => {
  // The channel that already had this right. An ad referral IS evidence of
  // sales intent; an ordinary DM is not.
  const source = read("src/lib/messenger.ts");
  assert.match(source, /if \(referral\) \{/);
  assert.match(source, /createLeadRecordIfPipelineReady/);
});
