import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

/**
 * "Test drives — 0 this month", on a day with a test drive booked, driven and
 * ticked off.
 *
 * The card counted `status === "planned"` only, so completing a booking REMOVED
 * it from the month's total. Do the drive, tick it off, watch the number go down
 * — while the same booking appears under "Completed — 7 this month", which is how
 * the two cards could disagree about the same row.
 *
 * The workshop-mode "Bookings — this month" card had the identical filter.
 */

type Event = { type: string; status: "planned" | "done" | "canceled" };

/** The month counts, as shipped. */
const happened = (event: Event) => event.status !== "canceled";
const testDrives = (events: Event[]) => events.filter((e) => e.type === "test_drive" && happened(e)).length;
const bookings = (events: Event[]) => events.filter(happened).length;
const completed = (events: Event[]) => events.filter((e) => e.status === "done").length;

test("completing a test drive does not remove it from the month", () => {
  const booked: Event[] = [{ type: "test_drive", status: "planned" }];
  assert.equal(testDrives(booked), 1);

  // The customer arrives, drives, and the booking is ticked off.
  const driven: Event[] = [{ type: "test_drive", status: "done" }];
  assert.equal(testDrives(driven), 1, "the drive still happened this month");
  assert.equal(completed(driven), 1, "and it is completed");
});

test("the two cards agree about the same booking", () => {
  // The reported symptom: one completed test drive showing as 0 test drives and
  // 1 completed. A row counted as completed must also be counted as having
  // happened, or the month's totals contradict each other.
  const events: Event[] = [{ type: "test_drive", status: "done" }];
  assert.ok(testDrives(events) >= completed(events.filter((e) => e.type === "test_drive")));
});

test("a cancelled booking is the one that did not happen", () => {
  const events: Event[] = [
    { type: "test_drive", status: "planned" },
    { type: "test_drive", status: "done" },
    { type: "test_drive", status: "canceled" },
  ];
  assert.equal(testDrives(events), 2, "planned and done count; cancelled does not");
  assert.equal(completed(events), 1);
});

test("only test drives count towards the test-drive card", () => {
  const events: Event[] = [
    { type: "test_drive", status: "done" },
    { type: "call", status: "done" },
    { type: "meeting", status: "planned" },
  ];
  assert.equal(testDrives(events), 1);
  // Workshop mode counts every activity in the month, on the same rule.
  assert.equal(bookings(events), 3);
});

test("workshop bookings count completed jobs too", () => {
  const events: Event[] = [
    { type: "service", status: "done" },
    { type: "service", status: "planned" },
    { type: "service", status: "canceled" },
  ];
  assert.equal(bookings(events), 2, "a finished job is still a booking this month");
});

test("the shipped counts use the same rule these tests model", () => {
  const code = src("src/components/CalendarWorkspace.tsx");
  const stats = code.slice(code.indexOf("const happened ="), code.indexOf("openSlots,\n    };"));
  assert.match(stats, /const happened = \(event: CalendarWorkspaceEvent\) => event\.status !== "canceled";/);
  assert.match(stats, /monthEvents\.filter\(happened\)\.length/, "workshop bookings");
  assert.match(stats, /event\.type === "test_drive" && happened\(event\)/, "test drives");
  // The defect, in both places.
  assert.doesNotMatch(stats, /event\.type === "test_drive" &&\s*event\.status === "planned"/);
  assert.doesNotMatch(stats, /\? monthEvents\.filter\(\(event\) => event\.status === "planned"\)\.length/);

  // "Today" is deliberately still planned-only — its own label says so.
  assert.match(stats, /event\.dateKey === todayKey && event\.status === "planned"/);
  assert.match(code, /detail: "planned activities"/);
});
