import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JOURNEY_EVENT_TRIGGERS } from "../src/lib/journeyTypes";
import { JOURNEY_TRIGGER_LABELS } from "../src/lib/journeyTriggers";
import { journeyTemplateVars } from "../src/lib/journeyContext";
import { deliveryDateText } from "../src/lib/deliveryDate";

/**
 * Sean, 2026-11-09: "I want journey trigger for the a delivery is scheduled and must use the variable of schedule
 * date from the deliveries board".
 */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the trigger exists and is named on screen", () => {
  assert.ok((JOURNEY_EVENT_TRIGGERS as readonly string[]).includes("delivery_scheduled"));
  assert.equal(JOURNEY_TRIGGER_LABELS.delivery_scheduled, "Delivery is scheduled or moved");
});

test("it fires from both of the board's doors — schedule and move — with the day booked", () => {
  const actions = read("src/app/actions/fulfilment.ts");
  const schedule = actions.slice(actions.indexOf("export async function scheduleDelivery("), actions.indexOf("export async function rescheduleDelivery("));
  const move = actions.slice(actions.indexOf("export async function rescheduleDelivery("), actions.indexOf("export type StagedDeliveryPhoto"));
  assert.match(schedule, /await emitDeliveryScheduledJourneyEvent\(quote, when, false\);/);
  assert.match(move, /await emitDeliveryScheduledJourneyEvent\(quote, when, true\);/);
  // After the day is claimed, not before: a refused booking enrols nobody.
  assert.ok(schedule.indexOf("updated.count !== 1") < schedule.indexOf("emitDeliveryScheduledJourneyEvent("));
  assert.ok(move.indexOf("updated.count !== 1") < move.indexOf("emitDeliveryScheduledJourneyEvent("));
  // DAX books through these same two actions, so it fires there too.
  assert.match(read("src/app/actions/assistant.ts"), /card\.from \? await rescheduleDelivery\(card\.quoteId, form\) : await scheduleDelivery\(card\.quoteId, form\)/);
});

test("each day is its own occurrence, and the event goes through the lead-or-customer hand-over", () => {
  const events = read("src/lib/leadJourneyEvents.ts");
  const body = events.slice(events.indexOf("export async function emitDeliveryScheduledJourneyEvent("));
  assert.match(body, /await emitForLeadOrContact\("delivery_scheduled", quote, \{/);
  assert.match(body, /occurrence: `quote:\$\{quote\.id\}:delivery:\$\{scheduledFor\.toISOString\(\)\.slice\(0, 10\)\}`/);
  assert.match(body, /deliveryDateText: deliveryDateText\(scheduledFor\)/);
});

test("{{delivery_date}} is the board's day, written out — the same day the board shows", () => {
  // The board stores the chosen day at midnight UTC ("2026-11-14" → 2026-11-14T00:00Z).
  assert.equal(deliveryDateText(new Date("2026-11-14")), "Saturday, 14 November 2026");
  const vars = journeyTemplateVars({ event: { type: "delivery_scheduled", deliveryDateText: "Saturday, 14 November 2026" } } as never);
  assert.equal(vars.delivery_date, "Saturday, 14 November 2026");
  assert.equal(journeyTemplateVars({ event: { type: "lead_created" } } as never).delivery_date, "", "empty on every other trigger");
});
