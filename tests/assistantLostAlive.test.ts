import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { aliveDeals, firstWorkingDayOfMonth, softLostReason } from "../src/lib/assistantLostAlive";
import { assistantStep, lookupStatus } from "../src/lib/crmAssistantPlan";
import { fastPath } from "../src/lib/assistantFastPath";
import { proposedAction } from "../src/lib/assistantActions";
import { WHATSAPP_CONFIRMABLE } from "../src/lib/assistantWhatsAppRules";
import { briefQuestion } from "../src/lib/proactiveRules";
import { kindFromSummary } from "../src/lib/assistantOutcomeRules";

const code = (path: string) => readFileSync(path, "utf8");

test("only a went-quiet or timing reason counts as 'not really lost'", () => {
  for (const r of ["Gone cold", "Stopped responding", "no response after quote", "Not replying", "ghosted us", "Buying next year", "Timing", "on hold till March"]) {
    assert.ok(softLostReason(r), r);
  }
  for (const r of ["Bought elsewhere", "Too expensive", "Went with a competitor", "", null, undefined]) assert.ok(!softLostReason(r), String(r));
});

test("the monthly list runs on the first working day only (Johannesburg)", () => {
  const sast = (iso: string) => new Date(`${iso}T07:30:00+02:00`);
  assert.ok(firstWorkingDayOfMonth(sast("2026-12-01")), "Tuesday 1 December");
  assert.ok(!firstWorkingDayOfMonth(sast("2026-12-02")));
  assert.ok(!firstWorkingDayOfMonth(sast("2026-11-01")), "Sunday 1 November");
  assert.ok(firstWorkingDayOfMonth(sast("2026-11-02")), "Monday 2 November");
  assert.ok(!firstWorkingDayOfMonth(sast("2026-11-03")));
  assert.ok(!firstWorkingDayOfMonth(sast("2026-08-01")), "Saturday 1 August");
  assert.ok(firstWorkingDayOfMonth(sast("2026-08-03")), "Monday 3 August");
  assert.ok(briefQuestion(sast("2026-11-02"), []).includes("lost_alive"));
  assert.ok(!briefQuestion(sast("2026-11-03"), []).includes("lost_alive"));
});

test("only signs of life AFTER the deal was lost count; newest first", () => {
  const lostAt = new Date("2026-10-01T10:00:00Z");
  const deal = (leadId: string, at: string[]) => ({ leadId, name: leadId, title: "Rover", lostAt, lostReason: "Gone cold", salesperson: null, signals: at.map((a) => ({ at: new Date(a), what: "sent a whatsapp message" })) });
  const result = aliveDeals([
    deal("before-only", ["2026-09-20T10:00:00Z"]),
    deal("older", ["2026-10-05T10:00:00Z", "2026-09-01T10:00:00Z"]),
    deal("newer", ["2026-10-20T10:00:00Z"]),
  ]);
  assert.deepEqual(result.map((d) => d.leadId), ["newer", "older"]);
  assert.equal(result[1].signals.length, 1, "the message from before it was lost is dropped");
});

test("lost_alive is a lookup DAX can run, quickly from the plain question", () => {
  assert.ok(assistantStep.safeParse({ tool: "lost_alive" }).success);
  assert.ok(assistantStep.safeParse({ tool: "lost_alive", args: { mine: true } }).success);
  assert.ok(!assistantStep.safeParse({ tool: "lost_alive", args: { userId: "someone" } }).success, "never another person's");
  assert.equal(lookupStatus([{ tool: "lost_alive" }]), "Checking lost deals for signs of life…");
  for (const q of ["which lost deals are still alive", "any lost deals worth another look", "deals lost but not really lost"]) {
    assert.deepEqual(fastPath(q, { userName: "Sean", pageLead: null }), [{ tool: "lost_alive", args: {} }], q);
  }
  assert.match(code("src/lib/crmAssistant.ts"), /case "lost_alive": return lostAliveLookup\(user, step\.args\.mine \?\? false\);/);
});

test("the lookup reads only deals the person can open, and only the customer's own quote views", () => {
  const lookup = code("src/lib/assistantLostAliveLookup.ts");
  assert.match(lookup, /getAccessibleLeadIds\(user\)/);
  // Review of #950: quotes are a separate permission — only quotes the person may open are read.
  assert.match(lookup, /getAccessibleQuoteIds\(user\)/);
  assert.match(lookup, /\{ id: \{ in: quoteIds \} \}/);
  assert.match(lookup, /status: "lost"/);
  assert.match(lookup, /direction: "inbound"/);
  assert.match(lookup, /isCustomerSigner/);
  assert.doesNotMatch(lookup, /basePrisma/);
});

test("reopen: a card through the lead page's own Reopen, confirmable on WhatsApp, read back by the outcomes report", () => {
  assert.ok(proposedAction.safeParse({ type: "reopen", leadId: "clead0000000001" }).success);
  assert.ok(!proposedAction.safeParse({ type: "reopen", leadId: "clead0000000001", stage: "Won" }).success);
  assert.ok(WHATSAPP_CONFIRMABLE.has("reopen"));
  assert.notEqual(kindFromSummary("Confirmed the assistant's proposal: reopen the deal"), null);
  const run = code("src/app/actions/assistant.ts");
  const block = run.slice(run.indexOf('case "reopen": {'), run.indexOf('case "reactivate": {'));
  assert.match(block, /canAccessLead\(user, card\.leadId\)/);
  assert.match(block, /now\.lostAt\?\.toISOString\(\) !== card\.lostAt\) return untouched\(STALE_CARD\)/);
  assert.match(block, /hasPermission\(user, "leads\.reopen"\)/);
  assert.ok(block.indexOf("leads.reopen") < block.indexOf("await reopenLead("), "permission asked before the write");
  assert.match(code("src/lib/crmAssistant.ts"), /p\.type === "reopen"\) \{\s*\/\/[^\n]*\n\s*if \(lead\.status !== "lost" \|\| !lead\.lostAt\)/);
});
