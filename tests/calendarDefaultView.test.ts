import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALENDAR_DEFAULT_VIEW, inDefaultCalendarView } from "../src/lib/calendarFilter";

// Sean 2026-10-02: the calendar opens on meetings, test drives and blocked time;
// every other activity is hidden until it is picked in the type filter.

test("the default view keeps meetings, test drives and blocked time only", () => {
  assert.equal(inDefaultCalendarView({ type: "meeting", availabilityBlock: false }), true);
  assert.equal(inDefaultCalendarView({ type: "test_drive", availabilityBlock: false }), true);
  assert.equal(inDefaultCalendarView({ type: "availability", availabilityBlock: true }), true);
  for (const type of ["call", "email", "whatsapp", "follow_up", "todo", "Golf Day"]) {
    assert.equal(inDefaultCalendarView({ type, availabilityBlock: false }), false, type);
  }
});

test("the three default-view types each have their own colour", () => {
  // Sean 2026-10-02: "everything is the same colour" — meeting and test drive
  // shared one orange and blocked time was a near-identical amber.
  const ws = readFileSync(new URL("../src/components/CalendarWorkspace.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const tone = (key: string) => ws.match(new RegExp(`\\n  ${key}: \\{[\\s\\S]*?tone: "([^"]+)"`))?.[1];
  const hue = (key: string) => tone(key)?.match(/bg-([a-z]+)-500/)?.[1];
  const hues = ["meeting", "test_drive", "availability"].map(hue);
  assert.equal(new Set(hues).size, 3, `distinct hues, got ${hues.join(", ")}`);
  // Blocked time takes its colour from the one map, not a hand-copied string.
  assert.equal(ws.match(/event\.availabilityBlock\s*\?\s*AVAILABILITY_TONE/g)?.length, 2);
  assert.doesNotMatch(ws, /border-amber-500\/35 bg-amber-500\/10/);
});

test("the sales calendar starts on the default view; Clear returns to it; workshop shows all", () => {
  const ws = readFileSync(new URL("../src/components/CalendarWorkspace.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.match(ws, /const defaultType = mode === "workshop" \? "" : CALENDAR_DEFAULT_VIEW;\n\s*const \[type, setType\] = useState\(defaultType\);/);
  assert.match(ws, /type === CALENDAR_DEFAULT_VIEW\s*\? inDefaultCalendarView\(event\)\s*: !type \|\| event\.type === type/);
  assert.match(ws, /setType\(defaultType\);/);
  assert.match(ws, /<option value="">All activities<\/option>/);
  assert.equal(CALENDAR_DEFAULT_VIEW.length > 0, true, "never the empty 'All activities' value");
});
