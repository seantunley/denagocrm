import test from "node:test";
import assert from "node:assert/strict";
import {
  calendarQueryBounds,
  isCalendarEventOverdue,
  johannesburgMidnight,
  shiftDateKey,
} from "../src/lib/calendarDates";

test("calendar query bounds represent Johannesburg midnight", () => {
  const bounds = calendarQueryBounds("2026-06-29", "2026-08-10");
  assert.equal(bounds.start.toISOString(), "2026-06-28T22:00:00.000Z");
  assert.equal(bounds.end.toISOString(), "2026-08-09T22:00:00.000Z");
});

test("timed activities earlier today are overdue", () => {
  const now = new Date("2026-07-16T14:00:00.000Z"); // 16:00 Johannesburg
  assert.equal(
    isCalendarEventOverdue({
      status: "planned",
      dueDate: new Date("2026-07-16T07:00:00.000Z"), // 09:00 Johannesburg
      dateOnly: false,
      now,
      todayKey: "2026-07-16",
    }),
    true,
  );
  assert.equal(
    isCalendarEventOverdue({
      status: "planned",
      dueDate: new Date("2026-07-16T15:00:00.000Z"), // 17:00 Johannesburg
      dateOnly: false,
      now,
      todayKey: "2026-07-16",
    }),
    false,
  );
});

test("all-day activities become overdue only after their Johannesburg day", () => {
  const now = new Date("2026-07-16T14:00:00.000Z");
  assert.equal(
    isCalendarEventOverdue({
      status: "planned",
      dueDate: new Date("2026-07-16T00:00:00.000Z"),
      dateOnly: true,
      now,
      todayKey: "2026-07-16",
    }),
    false,
  );
  assert.equal(
    isCalendarEventOverdue({
      status: "planned",
      dueDate: new Date("2026-07-15T00:00:00.000Z"),
      dateOnly: true,
      now,
      todayKey: "2026-07-16",
    }),
    true,
  );
  assert.equal(johannesburgMidnight("2026-07-16").toISOString(), "2026-07-15T22:00:00.000Z");
});

test("week navigation crosses month and year boundaries", () => {
  assert.equal(shiftDateKey("2026-07-27", 7), "2026-08-03");
  assert.equal(shiftDateKey("2026-01-05", -7), "2025-12-29");
});
