import assert from "node:assert/strict";
import test from "node:test";
import { ACTION_INSTRUCTIONS, CALENDAR_ITEM_RULE, TEST_DRIVE_RULE, proposedAction } from "../src/lib/assistantActions";

/*
 * Sean, 2026-10-29: "DAX requires a lead or contact to add a calendar item, that needs to change" — asked for a
 * meeting with Mariska (a prospect, no surname, not in the CRM) on Tuesday 11:00–11:45 at Atlantic Beach with Sean,
 * DAX found the slot and then said "the meeting card needs a lead to attach to". And: "when booking a test drive,
 * DAX requires a demo vehicle from stock. That is not needed." The CRM's own calendar and test-drive booking never
 * required either; only DAX did.
 */

const ID = "cmhv0000000000000000000a1";
const parse = (action: unknown) => proposedAction.safeParse(action);

test("a calendar item on a deal, on a customer with no deal, or on nobody at all", () => {
  for (const on of [{ leadId: ID }, { contactId: ID }, {}]) {
    assert.ok(parse({ type: "follow_up", ...on, when: "2026-11-03T15:00", activity: "call", summary: "Call the supplier" }).success, JSON.stringify(on));
    assert.ok(parse({ type: "meeting", ...on, when: "2026-11-03T11:00", minutes: 45, with: ["Sean"], summary: "Meeting with Mariska — Atlantic Beach" }).success, JSON.stringify(on));
  }
  // The example DAX is given is itself a valid action.
  const example = CALENDAR_ITEM_RULE.match(/\{"type":"meeting"[^}]*\}/)?.[0];
  assert.ok(example && parse(JSON.parse(example)).success, example);
  assert.equal(JSON.parse(example!).leadId, undefined);
});

test("a test drive with no demo vehicle: on the deal or the customer, the model and the place are enough", () => {
  assert.ok(parse({ type: "test_drive", leadId: ID, when: "2026-11-04T10:00" }).success, "no vehicle at all");
  assert.ok(parse({ type: "test_drive", contactId: ID, when: "2026-11-04T10:00", product: "Rover XL", branch: "Atlantic Beach" }).success, "on the customer directly");
  assert.ok(parse({ type: "test_drive", leadId: ID, when: "2026-11-04T10:00", vehicle: "Demo Rover XL" }).success, "a demo vehicle, when one is named");
});

test("DAX is told: calendar items need no lead or customer, and test drives need no demo vehicle", () => {
  assert.ok(ACTION_INSTRUCTIONS.includes(CALENDAR_ITEM_RULE) && ACTION_INSTRUCTIONS.includes(TEST_DRIVE_RULE));
  assert.match(CALENDAR_ITEM_RULE, /CALENDAR ITEMS need no deal and no customer/);
  assert.match(CALENDAR_ITEM_RULE, /NEVER say a calendar item needs a lead or a customer, never tell them to add it by hand, and never hang it on an unrelated deal or create a record to make one fit/);
  assert.match(TEST_DRIVE_RULE, /TEST DRIVES need NO demo vehicle/);
  assert.match(TEST_DRIVE_RULE, /Never refuse, stall or ask for a demo vehicle because none was named, and never pick one they didn't ask for/);
  // The old wording that made a demo vehicle, or a lead, sound required is gone.
  assert.doesNotMatch(ACTION_INSTRUCTIONS, /vehicle is the demo vehicle's name exactly as listed\. reschedule/);
  assert.doesNotMatch(ACTION_INSTRUCTIONS, /If you don't have it, look the lead up first or don't propose/);
});
