import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  MAX_LISTED,
  ONE_SHOT_KINDS,
  WATCH_KINDS,
  describeWatch,
  firedChanged,
  nextFiredState,
  safeName,
  watchInput,
  watchNotification,
} from "../src/lib/assistantWatchRules";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/* ── Input, per kind ─────────────────────────────────────────────────────── */

test("each kind takes its own target and wait, with defaults written in", () => {
  assert.deepEqual(watchInput.parse({ kind: "quote_viewed", quoteId: "Q-1042" }), { kind: "quote_viewed", quoteId: "Q-1042" });
  assert.equal(watchInput.parse({ kind: "quote_unsigned" }).thresholdHours, 48);
  assert.equal(watchInput.parse({ kind: "quote_unsigned", quoteId: "q1", thresholdHours: 6 }).thresholdHours, 6);
  assert.equal(watchInput.parse({ kind: "lead_quiet", product: "Club Car" }).thresholdDays, 7);
  assert.equal(watchInput.parse({ kind: "test_drive_no_follow_up" }).thresholdHours, 24);
  assert.equal(watchInput.parse({ kind: "delivery_deposit_due" }).thresholdHours, 48);
});

test("a field that doesn't belong to the kind is refused, not ignored", () => {
  const bad = [
    { kind: "quote_viewed" }, // needs its quote
    { kind: "quote_viewed", quoteId: "q1", thresholdHours: 5 },
    { kind: "quote_unsigned", leadId: "l1" },
    { kind: "lead_quiet", quoteId: "q1" },
    { kind: "lead_quiet", leadId: "l1", product: "Club Car" }, // one lead OR a product
    { kind: "lead_quiet", thresholdHours: 5 },
    { kind: "test_drive_no_follow_up", leadId: "l1" },
    { kind: "delivery_deposit_due", thresholdDays: 2 },
    { kind: "send_whatsapp" },
    { kind: "lead_quiet", thresholdDays: 0 },
    { kind: "lead_quiet", thresholdDays: 1000 },
    { kind: "quote_unsigned", thresholdHours: 1.5 },
    { kind: "lead_quiet", extra: true }, // strict
  ];
  for (const input of bad) assert.equal(watchInput.safeParse(input).success, false, JSON.stringify(input));
});

test("only 'tell me when she opens it' is one-shot", () => {
  assert.deepEqual([...ONE_SHOT_KINDS], ["quote_viewed"]);
  assert.equal(WATCH_KINDS.length, 5);
});

/* ── How it reads ────────────────────────────────────────────────────────── */

test("describeWatch reads as a sentence, with names when known", () => {
  assert.equal(describeWatch({ kind: "quote_viewed", quoteId: "q1" }, { quote: "Q-1042", customer: "Anna Jacobs" }), "Tell me when Anna Jacobs opens Q-1042");
  assert.equal(describeWatch({ kind: "quote_viewed", quoteId: "q1" }), "Tell me when the customer opens the quote");
  assert.equal(describeWatch({ kind: "quote_unsigned", thresholdHours: 48 }), "Tell me when any quote I can see is opened but not signed within 2 days");
  assert.equal(describeWatch({ kind: "lead_quiet", leadId: "l1", thresholdDays: 5 }, { lead: "Anna Jacobs" }), "Tell me if Anna Jacobs goes 5 days without contact");
  assert.equal(describeWatch({ kind: "lead_quiet", product: "Club Car" }), "Tell me when any open Club Car lead I can see goes 7 days without contact");
  assert.equal(describeWatch({ kind: "test_drive_no_follow_up", thresholdHours: 24 }), "Tell me when a test drive finished over 24 hours ago has no follow-up planned");
  assert.equal(describeWatch({ kind: "delivery_deposit_due", thresholdHours: null }), "Tell me when a delivery is within 2 days and the deposit isn't paid");
});

/* ── Episodes ────────────────────────────────────────────────────────────── */

test("a record is news once per episode, and again after the condition stops and comes back", () => {
  const t1 = new Date("2026-10-06T08:00:00Z");
  const t2 = new Date("2026-10-06T08:30:00Z");
  const first = nextFiredState(null, ["a", "b"], t1);
  assert.deepEqual(first.toNotify, ["a", "b"]);
  assert.deepEqual(first.fired, { a: t1.toISOString(), b: t1.toISOString() });

  // Still holding: nothing new, the original time kept.
  const second = nextFiredState(first.fired, ["a", "b"], t2);
  assert.deepEqual(second.toNotify, []);
  assert.equal(second.fired.a, t1.toISOString());
  assert.equal(firedChanged(first.fired, second.fired), false);

  // "a" stops holding: dropped, so it can fire again.
  const third = nextFiredState(second.fired, ["b"], t2);
  assert.deepEqual(third.fired, { b: t1.toISOString() });
  assert.equal(firedChanged(second.fired, third.fired), true);

  const fourth = nextFiredState(third.fired, ["a", "b"], t2);
  assert.deepEqual(fourth.toNotify, ["a"]);
});

test("an unreadable fired map counts as empty", () => {
  for (const junk of [null, undefined, "x", 3, ["a"], { a: 1 }]) {
    assert.deepEqual(nextFiredState(junk, ["a"], new Date(0)).toNotify, ["a"], JSON.stringify(junk));
  }
});

/* ── The note ────────────────────────────────────────────────────────────── */

test("the note is short, lists at most a handful, and never carries a phone number or email", () => {
  assert.equal(watchNotification({ kind: "quote_viewed" }, [{ ref: "Q-1042", customer: "Anna Jacobs" }]), "👀 Anna Jacobs opened Q-1042.");
  const hits = Array.from({ length: 8 }, (_, i) => ({ ref: `Lead ${i}`, customer: i % 2 ? "+27 82 123 4567" : "anna@example.com", detail: "never contacted" }));
  const note = watchNotification({ kind: "lead_quiet", thresholdDays: 7 }, hits);
  assert.equal(note.split("\n").filter((l) => l.startsWith("•")).length, MAX_LISTED);
  assert.match(note, /…and 3 more\.$/);
  assert.doesNotMatch(note, /@|\d{3} \d{4}/);
  assert.equal(safeName("0821234567"), "a customer");
  assert.equal(safeName("Anna Jacobs"), "Anna Jacobs");
  assert.equal(safeName("Q-1042 fleet of 12"), "Q-1042 fleet of 12");
});

/* ── Guards on the wiring ────────────────────────────────────────────────── */

test("the migration enables, polices and FORCES row level security on AssistantWatch", () => {
  const sql = src("prisma/migrations/20261006120000_assistant_watches/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "AssistantWatch"/);
  assert.match(sql, /ALTER TABLE "AssistantWatch" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "AssistantWatch_tenant_isolation" ON "AssistantWatch"\s*USING \([\s\S]*?"tenantId" = current_setting\('app\.current_tenant', true\)[\s\S]*?WITH CHECK/);
  assert.match(sql, /ALTER TABLE "AssistantWatch" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /FOREIGN KEY \("tenantId"\) REFERENCES "Tenant"\("id"\) ON DELETE CASCADE/);
  assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|ALTER COLUMN/, "additive only");
});

test("runAssistantWatches runs only in a real workspace and names it on every watch read and write", () => {
  const lib = src("src/lib/assistantWatch.ts");
  const run = lib.slice(lib.indexOf("export async function runAssistantWatches"));
  assert.match(run, /if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) return/);
  const calls = run.match(/(assistantWatch|assistantTurn)\.\w+\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(calls.length >= 5, "found the watch/turn queries");
  for (const call of calls) assert.match(call, /tenantId/, call);
  // Claimed before it is checked, and its result written only while the claim stands.
  assert.match(run, /where: \{ id: watch\.id, tenantId, active: true, lastCheckedAt: watch\.lastCheckedAt \},\s*data: \{ lastCheckedAt: now \}/);
  assert.match(run, /source: "watch"/);
  // The person, re-checked at run time; the push names nobody.
  assert.match(run, /await assistantUserFor\(watch\.userId\)/);
  assert.match(run, /body: `\$\{assistantName\}: something you're watching happened\.`/);
  // Every check reads the record tables with the tenant named too.
  const checks = lib.slice(0, lib.indexOf("export async function withWatchSlot"));
  for (const q of checks.match(/prisma\.(quote|lead|signatureRequest|testDriveBooking|activity)\.\w+\(\{\s*where: \{[^}]*/g) ?? []) {
    assert.match(q, /tenantId/, q);
  }
});

test("createWatchForUser checks the person can open the record, and the cap is under a lock", () => {
  const lib = src("src/lib/assistantWatch.ts");
  const create = lib.slice(lib.indexOf("export async function createWatchForUser"), lib.indexOf("export async function runAssistantWatches"));
  assert.match(create, /watchInput\.safeParse\(raw\)/);
  assert.match(create, /canAccessQuote\(user, quote\.id\)/);
  assert.match(create, /canAccessLead\(user, leadId\)/);
  assert.match(create, /isModuleEnabled\("automotive"\)/);
  assert.match(create, /withWatchSlot\(tenantId, user\.id,/);
  assert.match(create, /tenantId = ownedWriteTenantId\(\)/);
  assert.match(create, /action: "assistant\.watch_created"/);
  assert.doesNotMatch(create, /summary: `[^`]*label/, "no customer name in the audit summary");
  assert.match(lib, /pg_advisory_xact_lock\(hashtext\(\$\{`assistant-watches:\$\{userId\}`\}\)::bigint\)/);
});

test("checks run as the person: their lead, quote and test-drive visibility", () => {
  const lib = src("src/lib/assistantWatch.ts");
  for (const helper of ["getAccessibleLeadIds(user)", "getAccessibleQuoteIds(user)", "accessibleTestDriveWhere(user)", "canAccessQuote(user, w.quoteId)", "canAccessLead(user, w.leadId)"]) {
    assert.ok(lib.includes(helper), helper);
  }
  assert.match(lib, /contactCommunicationWhere/);
  assert.match(lib, /latestContactAt\(lead\.communications, lead\.activities\)/);
});

test("no record, label or note text reaches the log", () => {
  for (const file of ["src/lib/assistantWatch.ts", "src/app/api/cron/assistant/route.ts"]) {
    for (const call of src(file).match(/logError\([^;]*;/g) ?? []) {
      assert.match(call, /^logError\("assistant-(watch|schedule)", "[^"]+"(, error instanceof Error \? error\.name : "unknown")?/, call);
      assert.doesNotMatch(call, /label|answer|question|customer|watch\.|lead\.|quote\.|hits?\b/, call);
    }
  }
});

test("the cron runs watches before the schedules, and a watch failure can't stop them", () => {
  const route = src("src/app/api/cron/assistant/route.ts");
  assert.ok(route.indexOf("runAssistantWatches(budget)") < route.indexOf("runDueAssistantSchedules(budget)"));
  assert.match(route, /runAssistantWatches\(budget\)\.catch\(/);
  assert.match(route, /\)\.catch\(async \(error: unknown\) => \{\s*await logError\("assistant-schedule", "watch run failed"/);
});

test("pause, resume and delete act only on the caller's own watch, behind the assistant gate", () => {
  const actions = src("src/app/actions/assistantWatches.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(actions, /export (const|function|class|type|let)\b/, "a server-action file exports only async functions");
  assert.match(actions, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  const queries = actions.match(/assistantWatch\.\w+\(\{\s*where: \{[^}]*\}/g) ?? [];
  assert.equal(queries.length, 4);
  for (const q of queries) {
    assert.match(q, /userId/, q);
    assert.match(q, /tenantId/, q);
  }
  assert.match(actions, /withWatchSlot\(watch\.tenantId, user\.id,/);
  assert.match(actions, /revalidatePath\("\/assistant"\)/);
});

test("fired watches light the bubble and every watch is listed on the Ask page", () => {
  assert.match(src("src/lib/assistantScheduleRun.ts"), /source: \{ in: \["schedule", "watch"\] \}, seenAt: null/);
  assert.match(src("src/app/(app)/layout.tsx"), /source: \{ in: \["schedule", "watch"\] \}, seenAt: null/);
  const page = src("src/app/(app)/assistant/page.tsx");
  assert.match(page, /prisma\.assistantWatch\.findMany\(\{\s*where: \{ userId: user\.id \}/);
  assert.match(page, /onConfirm=\{deleteAssistantWatch\.bind\(null, w\.id\)\}/);
  assert.match(page, /onConfirm=\{setAssistantWatchActive\.bind\(null, w\.id, !w\.active\)\}/);
});
