import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ASSISTANT_PROACTIVE_KEY,
  DAILY_ALERT_CEILING,
  PROACTIVE_KINDS,
  isQuietHour,
  johannesburgDayStart,
  nextMorning,
  proactiveDeliverAt,
  proactiveOn,
  proactivePersonKey,
  proactivePush,
  proactiveText,
  responsiblePerson,
  BRIEF_DEFAULT,
  BRIEF_LEASE_MS,
  BRIEF_TIMES,
  briefDueKey,
  briefQuestion,
  checkBackTiming,
  johannesburgDateKey,
  parseBriefAt,
} from "../src/lib/proactiveRules";
import { PROACTIVE_SOURCES } from "../src/lib/assistantWhatsAppRules";
import { CHECK_BACK_RULE, parseActionList } from "../src/lib/assistantActions";

/*
 * Proactive DAX, part 1 (Sean, 2026-10-18: "I want DAX to function like OpenClaw and Hermes, proactive";
 * docs/proactive-dax-plan-2026-10-18.md): customer activity reaches the person responsible as it happens.
 */
const read = (path: string) => readFileSync(path, "utf8");
/** A Johannesburg wall-clock time (UTC+2) as an instant. */
const sa = (iso: string) => new Date(`${iso}+02:00`);

test("the words: who, what, and the way to the record — short enough for a lock screen", () => {
  const origin = "https://crm.example.co.za/";
  const opened = proactiveText({ kind: "quote_opened", customer: "Thabo Nkosi", url: "/quotes/q1", detail: "Q-1032", recordKey: "q1" }, origin);
  assert.equal(opened, "👀 Thabo Nkosi just opened quote Q-1032.\nhttps://crm.example.co.za/quotes/q1");
  assert.match(proactiveText({ kind: "quote_revisited", customer: "Thabo", url: "/quotes/q1", detail: "Q-1032", recordKey: "q1" }, origin), /opened Q-1032 3 times and hasn't signed/);
  assert.match(proactiveText({ kind: "quote_signed", customer: "Thabo", url: "/quotes/q1", detail: "Q-1032", recordKey: "q1" }, origin), /^✅ Thabo signed Q-1032\./);
  assert.match(proactiveText({ kind: "service_booked", customer: "Thabo", url: "/contacts/c1", detail: "20 Oct 2026 at 09:00", recordKey: "a1" }, origin), /New service booking from Thabo for 20 Oct 2026 at 09:00\./);
  const waiting = proactiveText({ kind: "customer_waiting", customer: "", url: "/contacts/c1", detail: "WhatsApp", minutesAgo: 18, snippet: "Hi, is the Rover still available?\nCan I come see it", recordKey: "k" }, origin);
  assert.match(waiting, /^💬 A customer wrote on WhatsApp 18 min ago and no one has answered yet: “Hi, is the Rover still available\? Can I come see it”/);
  assert.ok(proactiveText({ kind: "customer_waiting", customer: "X", url: "/x", snippet: "a".repeat(500), recordKey: "k" }, origin).length < 220, "a long message is cut");
});

test("the phone notification names nobody — a lock screen is not private", () => {
  for (const kind of PROACTIVE_KINDS) assert.doesNotMatch(proactivePush(kind), /[A-Z][a-z]+ [A-Z]|Q-\d/);
});

test("never at night: 20:00–08:00 waits for 08:00; the day's ceiling waits for tomorrow", () => {
  assert.equal(isQuietHour(sa("2026-10-18T21:30:00")), true);
  assert.equal(isQuietHour(sa("2026-10-18T07:59:00")), true);
  assert.equal(isQuietHour(sa("2026-10-18T08:00:00")), false);
  assert.equal(isQuietHour(sa("2026-10-18T19:59:00")), false);
  assert.equal(proactiveDeliverAt(sa("2026-10-18T21:30:00"), 0)?.toISOString(), sa("2026-10-19T08:00:00").toISOString());
  assert.equal(proactiveDeliverAt(sa("2026-10-18T06:10:00"), 0)?.toISOString(), sa("2026-10-18T08:00:00").toISOString());
  assert.equal(proactiveDeliverAt(sa("2026-10-18T10:00:00"), DAILY_ALERT_CEILING - 1), null, "now, under the ceiling");
  assert.equal(proactiveDeliverAt(sa("2026-10-18T10:00:00"), DAILY_ALERT_CEILING)?.toISOString(), sa("2026-10-19T08:00:00").toISOString());
  assert.equal(nextMorning(sa("2026-10-18T08:00:00")).toISOString(), sa("2026-10-18T08:00:00").toISOString());
  assert.equal(johannesburgDayStart(sa("2026-10-18T00:30:00")).toISOString(), sa("2026-10-18T00:00:00").toISOString());
});

test("whose alert: the deal's owner, else the customer's, else whoever made it", () => {
  assert.equal(responsiblePerson({ dealOwnerId: "d", customerOwnerId: "c", fallbackId: "f" }), "d");
  assert.equal(responsiblePerson({ dealOwnerId: null, customerOwnerId: "c", fallbackId: "f" }), "c");
  assert.equal(responsiblePerson({ fallbackId: "f" }), "f");
  assert.equal(responsiblePerson({}), null);
});

test("both switches default OFF: the owner's for the workspace and each person's own", () => {
  assert.equal(proactiveOn(null), false);
  assert.equal(proactiveOn("off"), false);
  assert.equal(proactiveOn("on"), true);
  assert.equal(proactivePersonKey("u1"), "ASSISTANT_PROACTIVE_FOR:u1");
  const core = read("src/lib/proactive.ts");
  assert.match(core, /if \(!proactiveOn\(await setting\(tenantId, ASSISTANT_PROACTIVE_KEY\)\)\) return false;\s*return proactiveOn\(await setting\(tenantId, proactivePersonKey\(userId\)\)\);/);
  // Only about a record that person may open, as themselves.
  assert.match(core, /const user = await assistantUserFor\(userId\);/);
  assert.match(core, /canAccessLead\(user, target\.leadId\)[\s\S]{0,80}canAccessContact\(user, target\.contactId\)/);
  // The owner's switch is owner-only and audited; a person's switch names only themselves.
  const actions = read("src/app/actions/assistantSettings.ts");
  assert.match(actions, /export async function saveAssistantProactive[\s\S]{0,200}requireTenantOwner\(\)/);
  assert.match(actions, /export async function setMyProactive[\s\S]{0,400}const key = proactivePersonKey\(user\.id\);/);
  assert.equal(ASSISTANT_PROACTIVE_KEY, "ASSISTANT_PROACTIVE");
});

test("never twice: unique per person, kind and record; claimed before it is sent", () => {
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model AssistantProactiveAlert \{[\s\S]*?@@unique\(\[tenantId, userId, kind, recordKey\]\)/);
  const sql = read("prisma/migrations/20261018120000_assistant_proactive_alerts/migration.sql");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "AssistantProactiveAlert_tenantId_userId_kind_recordKey_key"/);
  assert.match(sql, /ALTER TABLE "AssistantProactiveAlert" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "AssistantProactiveAlert" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "AssistantProactiveAlert_tenant_isolation"/);
  const core = read("src/lib/proactive.ts");
  assert.match(core, /if \(\(error as \{ code\?: string \}\)\.code === "P2002"\) return null;/, "an event already told is silent");
  assert.match(core, /updateMany\(\{ where: \{ id: alertId, tenantId, deliveredAt: null \}, data: \{ deliveredAt: new Date\(\) \} \}\);\s*if \(claimed\.count !== 1\) return false;/);
  // And it rides the existing delivery: the red dot, seen-marking and WhatsApp include it.
  assert.ok((PROACTIVE_SOURCES as readonly string[]).includes("proactive"));
});

test("each customer event raises it, and never at the cost of what the customer was doing", () => {
  assert.match(read("src/lib/signing/quoteMirror.ts"), /if \(firstView\) await \(await import\("@\/lib\/proactive"\)\)\.notifyQuoteActivity\(tenantId, quoteId, "quote_opened"\);/);
  const view = read("src/app/api/signing/[token]/view/route.ts");
  assert.match(view, /request\.quoteId && sittings \+ 1 === REVISIT_ALERT_AT && \(await isCustomerSigner\(recipient, tenantId\)\)/);
  assert.match(read("src/lib/signing/postComplete.ts"), /await effect\("dax_proactive", failures, async \(\) =>\s*\(await import\("@\/lib\/proactive"\)\)\.notifyQuoteActivity\(quote\.tenantId, quote\.id, "quote_signed"\)/);
  assert.match(read("src/app/api/bookings/route.ts"), /kind: "service_booked"[\s\S]{0,200}recordKey: outcome\.activityId/);
  assert.match(read("src/app/api/cron/assistant/route.ts"), /await sweepProactive\(tenantId, budget\)/);
  const core = read("src/lib/proactive.ts");
  // No wait on the customer's request: the platform finishes it after the response (review of #896); awaited only
  // where there is no request. A failure is logged by name only.
  assert.doesNotMatch(core, /Promise\.race|NOTIFY_WAIT_MS/);
  assert.match(core, /if \(!\(await finishAfterResponse\(work\)\)\) await work;/);
  assert.match(core, /after\(\(\) => work\);\s*return true;\s*\} catch \{\s*return false;/);
  assert.match(core, /logError\("dax-proactive", `raising a \$\{event\.kind\} alert failed`, error instanceof Error \? error\.name : "unknown"\)/);
  // Waiting customers only in working hours; one alert per message burst.
  assert.match(core, /if \(isQuietHour\(now\)\) return stats;/);
  assert.match(core, /recordKey: `\$\{c\.id\}:\$\{c\.lastInboundAt\?\.toISOString\(\) \?\? ""\}`/);
});

test("an alert is never lost: the claim, the message and the link are one transaction (review of #896)", () => {
  const core = read("src/lib/proactive.ts");
  const deliver = core.slice(core.indexOf("async function deliver("), core.indexOf("async function briefStillToCome("));
  // If the message can't be written the claim rolls back, so the sweep (deliveredAt: null) tries it again.
  assert.match(
    deliver,
    /basePrisma\.\$transaction\(async \(tx\) => \{\s*const claimed = await tx\.assistantProactiveAlert\.updateMany\(\{ where: \{ id: alertId, tenantId, deliveredAt: null \}, data: \{ deliveredAt: new Date\(\) \} \}\);\s*if \(claimed\.count !== 1\) return false;\s*const turn = await tx\.assistantTurn\.create\([\s\S]{0,250}await tx\.assistantProactiveAlert\.updateMany\(\{ where: \{ id: alertId, tenantId \}, data: \{ turnId: turn\.id \} \}\);/,
  );
  assert.doesNotMatch(deliver, /basePrisma\.assistantTurn\.create/, "the message is never written outside the claim's transaction");
  // The phone and WhatsApp only once it is saved.
  assert.ok(deliver.indexOf("if (!sent) return false;") < deliver.indexOf("sendPushToAll("));
});

/* ---------- Part 2: the morning brief ---------- */

test("the brief's time: a half hour from 06:00 to 10:00, 07:30 unless chosen, or off", () => {
  assert.deepEqual(BRIEF_TIMES, ["06:00", "06:30", "07:00", "07:30", "08:00", "08:30", "09:00", "09:30", "10:00"]);
  assert.equal(parseBriefAt(null), BRIEF_DEFAULT);
  assert.equal(BRIEF_DEFAULT, "07:30");
  assert.equal(parseBriefAt("09:00"), "09:00");
  assert.equal(parseBriefAt("off"), null);
  assert.equal(parseBriefAt("03:00"), BRIEF_DEFAULT, "a time never offered is the default, not obeyed");
});

test("due on a weekday from its time until 11:00; never at the weekend", () => {
  // 2026-10-19 is a Monday.
  assert.equal(briefDueKey(sa("2026-10-19T07:29:00"), "07:30"), null);
  assert.equal(briefDueKey(sa("2026-10-19T07:30:00"), "07:30"), "2026-10-19");
  assert.equal(briefDueKey(sa("2026-10-19T10:59:00"), "07:30"), "2026-10-19", "a missed tick still writes it in the morning");
  assert.equal(briefDueKey(sa("2026-10-19T11:00:00"), "07:30"), null);
  assert.equal(briefDueKey(sa("2026-10-18T08:00:00"), "07:30"), null, "Sunday");
  assert.equal(briefDueKey(sa("2026-10-17T08:00:00"), "07:30"), null, "Saturday");
  assert.equal(johannesburgDateKey(sa("2026-10-19T00:30:00")), "2026-10-19");
});

test("the brief folds in what was held overnight — the words, not the links", () => {
  const q = briefQuestion(sa("2026-10-19T07:30:00"), ["👀 Thabo just opened quote Q-1032.\nhttps://crm/x", "✅ Anna signed Q-1040.\nhttps://crm/y"]);
  assert.match(q, /Monday, 19 October/);
  assert.match(q, /Since last night: 👀 Thabo just opened quote Q-1032\. · ✅ Anna signed Q-1040\./);
  assert.doesNotMatch(q, /https:/);
  assert.match(q, /three things that matter most/);
  assert.doesNotMatch(briefQuestion(sa("2026-10-19T07:30:00"), []), /Since last night/);
});

test("the brief: once a day, as the person, folding in held alerts, labelled as the brief", () => {
  const brief = read("src/lib/proactiveBrief.ts");
  // The claim: one row per person per day, unique. BEING WRITTEN is a lease, WRITTEN is deliveredAt (review of #896):
  // a failed try gives the lease back and the next tick retries; a dead worker's lease runs out — after the route's life.
  assert.match(brief, /create\(\{ data: \{ tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, text: "", claimedAt: now \}/);
  assert.match(brief, /if \(\(error as \{ code\?: string \}\)\.code === "P2002"\) return null;/);
  assert.match(brief, /tenantId, userId, kind: BRIEF_KIND, recordKey: dayKey, deliveredAt: null,\s*OR: \[\{ claimedAt: null \}, \{ claimedAt: \{ lt: new Date\(now\.getTime\(\) - BRIEF_LEASE_MS\) \} \}\],/);
  assert.match(brief, /if \(!written\) \{\s*await basePrisma\.assistantProactiveAlert\s*\.updateMany\(\{ where: \{ id: claimId, tenantId, deliveredAt: null, claimedAt: now \}, data: \{ claimedAt: null \} \}\)/);
  const routeLife = Number(/export const maxDuration = (\d+);/.exec(read("src/app/api/cron/assistant/route.ts"))?.[1]);
  assert.ok(BRIEF_LEASE_MS > routeLife * 1000, "a lease only runs out once its worker is certainly gone");
  // Done in one step: labelled, the day marked written, the held alerts marked delivered in it.
  assert.match(brief, /data: \{ text: BRIEF_QUESTION, turnId, deliveredAt: new Date\(\), claimedAt: null \}/);
  // Only a WRITTEN brief stops the held alerts waiting for it.
  assert.match(read("src/lib/proactive.ts"), /kind: BRIEF_KIND, recordKey: johannesburgDateKey\(now\), deliveredAt: \{ not: null \} \}/);
  // As them, inside their hourly ask limit, unattended (no questions back, nothing learned).
  assert.match(brief, /const user = await assistantUserFor\(userId\);\s*if \(!user \|\| !\(await assistantAskAllowed\(user\.id\)\)\) return false;/);
  assert.match(brief, /askCrm\(user, briefQuestion\(now, held\.map\(\(alert\) => alert\.text\)\), null, \{ source: "schedule" \}\)/);
  assert.match(brief, /data: \{ source: BRIEF_SOURCE, question: BRIEF_QUESTION \}/);
  assert.match(brief, /id: \{ in: held\.map\(\(alert\) => alert\.id\) \}, deliveredAt: null \},\s*data: \{ deliveredAt: new Date\(\), turnId \}/);
  // Held alerts wait for a brief still to come today; otherwise they go on their own.
  assert.match(read("src/lib/proactive.ts"), /if \(waitForBrief\.get\(userId\)\) continue;/);
  assert.match(read("src/app/api/cron/assistant/route.ts"), /await runMorningBriefs\(tenantId, budget\)/);
  assert.ok((PROACTIVE_SOURCES as readonly string[]).includes("brief"));
  assert.match(read("src/app/actions/assistantSettings.ts"), /export async function setMyBriefTime[\s\S]{0,400}if \(at !== "off" && !BRIEF_TIMES\.includes\(at\)\) refuse\(/);
});

/* ---------- Part 3: DAX checks back ---------- */

test("a check-back: at least an hour away, within 30 days, on the half hour", () => {
  const now = sa("2026-10-19T10:00:00");
  assert.deepEqual(checkBackTiming("2026-10-19T10:30", now), { refused: "the time has to be between an hour and 30 days from now" });
  const thursday = checkBackTiming("2026-10-22T09:10", now);
  assert.ok(!("refused" in thursday));
  if (!("refused" in thursday)) {
    assert.equal(thursday.timeOfDay, "09:00", "snapped to the half hour the runner wakes on");
    assert.equal(thursday.at.toISOString(), sa("2026-10-22T09:00:00").toISOString());
  }
  assert.ok("refused" in checkBackTiming("2026-12-01T09:00", now), "more than 30 days ahead");
  assert.ok("refused" in checkBackTiming("2026-10-18T09:00", now), "in the past");
});

test("DAX may propose one, offered only while proactive DAX is on, never as a card", () => {
  const parsed = parseActionList([{ type: "check_back", question: "Has Anna Jacobs signed quote Q-1032?", when: "2026-10-22T09:00", reason: "she said Thursday" }]);
  assert.equal(parsed.length, 1);
  assert.equal(parseActionList([{ type: "check_back", question: "x", when: "Thursday" }]).length, 0, "a vague time is not one");
  assert.match(CHECK_BACK_RULE, /It needs no Confirm/);
  assert.match(CHECK_BACK_RULE, /Do NOT mention it in your answer — the CRM adds a line/);
  const core = read("src/lib/crmAssistant.ts");
  assert.match(core, /const checksBack = source !== "schedule" && \(await checkBacksOn\(user\.id\)\.catch\(\(\) => false\)\);/);
  assert.match(core, /checksBack \? CHECK_BACK_RULE : ""/);
  // Taken out before the cards and never counted as a task that came to nothing.
  assert.match(core, /const proposals = reply\.actions\.filter\(\(p\) => p\.type !== "check_back"\);/);
  assert.match(core, /reply\.attempted - checkBacks\.length - actions\.length - problems\.length/);
  // What the person is told comes from what was SAVED.
  assert.match(core, /const answer = \(settled \?\? resolved\.plain \+ note\) \+ checkBackLine;/);
});

test("saved as the person's one-off question marked set by DAX, with its own cap; runs only while it's on", () => {
  const follow = read("src/lib/proactiveFollowUp.ts");
  assert.match(follow, /count\(\{ where: \{ userId: user\.id, active: true, setBy: "dax" \} \}\)\) >= MAX_DAX_FOLLOW_UPS\) return null;/);
  assert.match(follow, /cadence: "once",[\s\S]{0,200}setBy: "dax",/);
  assert.match(follow, /return `\\n\\n🔁 I'll check back \$\{formatDateTime\(timing\.at\)\}/);
  // The person's own ten are not used up by DAX's.
  assert.match(read("src/lib/assistantScheduleRun.ts"), /count\(\{ where: \{ userId, active: true, setBy: "person" \} \}\)\) >= MAX_ACTIVE_SCHEDULES\) return null;/);
  const run = read("src/lib/assistantScheduleRun.ts");
  assert.match(run, /if \(daxSet && !\(await switchedOn\(tenantId, schedule\.userId\)\.catch\(\(\) => false\)\)\) \{/);
  assert.match(run, /data: \{ source: FOLLOW_UP_SOURCE \}/);
  assert.ok((PROACTIVE_SOURCES as readonly string[]).includes("followup"));
  assert.match(read("src/app/(app)/assistant/page.tsx"), /s\.setBy === "dax" && <p[^>]*>🔁 Set by \{profile\.name\}/);
  const sql = read("prisma/migrations/20261018130000_assistant_schedule_set_by/migration.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "setBy" TEXT NOT NULL DEFAULT 'person';/);
});

test("it is on the automations page, reaching staff only", () => {
  const register = read("src/lib/automationRegister.ts");
  assert.match(register, /key: "dax-proactive",[\s\S]{0,900}reaches: "staff",[\s\S]{0,300}managedAt: \{ label: "Settings → Assistant", href: "\/settings\/assistant" \}/);
});
