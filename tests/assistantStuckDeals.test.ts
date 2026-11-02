import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { overLimit } from "../src/lib/assistantStuck";
import { assistantStep, lookupStatus } from "../src/lib/crmAssistantPlan";
import { briefQuestion, isJohannesburgMonday, mondayStuckKey } from "../src/lib/proactiveRules";

const code = (path: string) => readFileSync(path, "utf8");
const DAY = 86_400_000;

test("most stuck = furthest past the stage's own limit; no limit counts against 14 days", () => {
  const now = new Date("2026-11-09T08:00:00Z");
  assert.equal(overLimit(new Date(now.getTime() - 20 * DAY), 7, now), 13);
  assert.equal(overLimit(new Date(now.getTime() - 5 * DAY), 7, now), -2);
  assert.equal(overLimit(new Date(now.getTime() - 20 * DAY), null, now), 6);
  assert.equal(overLimit(new Date(now.getTime() - 20 * DAY), 0, now), 6);
});

test("the Monday part: only on a Johannesburg Monday, and only for someone who switched it on", () => {
  const monday = new Date("2026-11-09T05:30:00Z"); // 07:30 SAST, Monday
  const tuesday = new Date("2026-11-10T05:30:00Z");
  assert.ok(isJohannesburgMonday(monday));
  assert.ok(!isJohannesburgMonday(tuesday));
  assert.ok(isJohannesburgMonday(new Date("2026-11-08T22:30:00Z")), "Sunday 22:30 UTC is already Monday 00:30 in Johannesburg");
  assert.match(briefQuestion(monday, [], { mondayStuck: true }), /run stuck_deals/);
  assert.doesNotMatch(briefQuestion(monday, [], { mondayStuck: false }), /stuck_deals/);
  assert.doesNotMatch(briefQuestion(monday, []), /stuck_deals/, "off unless switched on");
  assert.doesNotMatch(briefQuestion(tuesday, [], { mondayStuck: true }), /stuck_deals/);
  assert.equal(mondayStuckKey("u1"), "ASSISTANT_MONDAY_STUCK_FOR:u1");
});

test("stuck_deals is a lookup with no arguments — never another person's", () => {
  assert.ok(assistantStep.safeParse({ tool: "stuck_deals" }).success);
  assert.ok(!assistantStep.safeParse({ tool: "stuck_deals", args: { userId: "x" } }).success);
  assert.equal(lookupStatus([{ tool: "stuck_deals" }]), "Finding your most-stuck deals…");
  assert.match(code("src/lib/crmAssistant.ts"), /case "stuck_deals": return stuckDealsLookup\(user\);/);
});

test("the lookup: their own lead list, the one-deal stuck check's own reasons, read-only", () => {
  const lookup = code("src/lib/assistantStuckDeals.ts");
  assert.match(lookup, /getAccessibleLeadIds\(user\)/);
  assert.match(lookup, /status: "open"/);
  assert.match(lookup, /stuckLookup\(user, id\)/);
  assert.doesNotMatch(lookup, /basePrisma|\.(create|update|delete)\w*\(/);
});

test("the switch: each person's own, audited, shown on the Ask page under the brief time", () => {
  const action = code("src/app/actions/assistantSettings.ts");
  const fn = action.slice(action.indexOf("export async function setMyMondayStuck"), action.indexOf("export async function setMyBriefTime"));
  assert.match(fn, /mondayStuckKey\(user\.id\)/);
  assert.match(fn, /logAudit\(/);
  assert.match(code("src/lib/proactiveBrief.ts"), /proactiveOn\(await setting\(tenantId, mondayStuckKey\(userId\)\)\)/);
  assert.match(code("src/components/AssistantProactiveCard.tsx"), /Stuck deals on Mondays/);
});
