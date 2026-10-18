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
} from "../src/lib/proactiveRules";
import { PROACTIVE_SOURCES } from "../src/lib/assistantWhatsAppRules";

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
  // A short wait, then the platform finishes it; a failure is logged by name only.
  assert.match(core, /const NOTIFY_WAIT_MS = 2_500;/);
  assert.match(core, /logError\("dax-proactive", `raising a \$\{event\.kind\} alert failed`, error instanceof Error \? error\.name : "unknown"\)/);
  // Waiting customers only in working hours; one alert per message burst.
  assert.match(core, /if \(isQuietHour\(now\)\) return stats;/);
  assert.match(core, /recordKey: `\$\{c\.id\}:\$\{c\.lastInboundAt\?\.toISOString\(\) \?\? ""\}`/);
});

test("it is on the automations page, reaching staff only", () => {
  const register = read("src/lib/automationRegister.ts");
  assert.match(register, /key: "dax-proactive",[\s\S]{0,900}reaches: "staff",[\s\S]{0,300}managedAt: \{ label: "Settings → Assistant", href: "\/settings\/assistant" \}/);
});
