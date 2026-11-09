import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JOURNEY_EVENT_TRIGGERS } from "../src/lib/journeyTypes";
import { JOURNEY_TRIGGER_LABELS } from "../src/lib/journeyTriggers";
import { journeyTemplateVars } from "../src/lib/journeyContext";
import { deliveryDateText, staleDeliveryRunReason } from "../src/lib/deliveryDate";

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

test("each scheduling CHANGE is its own occurrence — 14th → 16th → 14th fires three times (review of #1044)", () => {
  const events = read("src/lib/leadJourneyEvents.ts");
  const body = events.slice(events.indexOf("export async function emitDeliveryScheduledJourneyEvent("));
  assert.match(body, /await emitForLeadOrContact\("delivery_scheduled", quote, \{/);
  assert.match(body, /const changeId = randomUUID\(\);/);
  assert.match(body, /occurrence: `quote:\$\{quote\.id\}:delivery:\$\{changeId\}`/);
  assert.match(body, /changeId,/);
  assert.match(body, /deliveryDateText: deliveryDateText\(scheduledFor\)/);
  assert.doesNotMatch(body, /occurrence: `quote:\$\{quote\.id\}:delivery:\$\{scheduledFor/, "the day alone is not an occurrence");
});

test("a run from an earlier scheduling change stops before it sends (review of #1044)", () => {
  const event = { type: "delivery_scheduled", quoteId: "q1", changeId: "c1", deliveryDate: "2026-11-14" };
  assert.equal(staleDeliveryRunReason(event, { day: "2026-11-14", latestChangeId: "c1" }), null, "still the latest change");
  // Moved to the 16th: stops, naming the day that now stands.
  assert.match(staleDeliveryRunReason(event, { day: "2026-11-16", latestChangeId: "c2" }) ?? "", /scheduled again \(now Monday, 16 November 2026\)/);
  // Moved away and BACK to the 14th: same day, newer change — still stops, or the customer hears it twice.
  assert.match(staleDeliveryRunReason(event, { day: "2026-11-14", latestChangeId: "c3" }) ?? "", /a newer run speaks for it/);
  // The board has saved the 16th but the newer event isn't recorded yet: this run is still "the latest change",
  // and must stop anyway rather than announce the 14th (review of #1044).
  assert.match(staleDeliveryRunReason(event, { day: "2026-11-16", latestChangeId: "c1" }) ?? "", /now Monday, 16 November 2026/);
  assert.match(staleDeliveryRunReason(event, { day: null, latestChangeId: "c1" }) ?? "", /no longer scheduled/);
  assert.match(staleDeliveryRunReason(event, undefined) ?? "", /is gone/);
  assert.equal(staleDeliveryRunReason({ type: "lead_created" }, undefined), null, "other triggers are never stale here");

  const runner = read("src/lib/journeyRuns.ts");
  const guard = runner.indexOf("staleDeliveryRunReason(");
  assert.ok(guard > runner.indexOf("const owned = await prisma.journeyRun.count") && guard < runner.indexOf("result = await executeJourneyStep({"), "checked in front of every action, before it runs");
  assert.match(runner, /payload: \{ path: \["quoteId"\], equals: deliveryEvent\.quoteId \}/);
  assert.match(runner, /if \(stale\) \{[\s\S]{0,200}return finish\(stale\);/);
});

test("{{delivery_date}} is the board's day, written out — the same day the board shows", () => {
  // The board stores the chosen day at midnight UTC ("2026-11-14" → 2026-11-14T00:00Z).
  assert.equal(deliveryDateText(new Date("2026-11-14")), "Saturday, 14 November 2026");
  const vars = journeyTemplateVars({ event: { type: "delivery_scheduled", deliveryDateText: "Saturday, 14 November 2026" } } as never);
  assert.equal(vars.delivery_date, "Saturday, 14 November 2026");
  assert.equal(journeyTemplateVars({ event: { type: "lead_created" } } as never).delivery_date, "", "empty on every other trigger");
});
