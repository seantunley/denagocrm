import assert from "node:assert/strict";
import test from "node:test";
import { nextStepDueDate } from "../src/lib/businessHours";

// Reference calendar (2026): Jan 1 = Thursday, Jan 2 = Friday,
// Jan 3 = Saturday, Jan 4 = Sunday, Jan 5 = Monday.

test("normalises the time-of-day to the configured hour regardless of base time", () => {
  // A lead created late at night must not produce a task due late at night.
  const base = new Date(2026, 0, 6, 23, 9, 42, 500); // Tue 2026-01-06 23:09:42.500
  const due = nextStepDueDate(base, 1, { hour: 9, skipWeekends: true });
  assert.equal(due.getFullYear(), 2026);
  assert.equal(due.getMonth(), 0);
  assert.equal(due.getDate(), 7); // next day, a Wednesday
  assert.equal(due.getHours(), 9);
  assert.equal(due.getMinutes(), 0);
  assert.equal(due.getSeconds(), 0);
  assert.equal(due.getMilliseconds(), 0);
});

test("honours the configured hour value", () => {
  const base = new Date(2026, 0, 6, 3, 0, 0); // early morning
  const due = nextStepDueDate(base, 1, { hour: 14, skipWeekends: false });
  assert.equal(due.getHours(), 14);
  assert.equal(due.getMinutes(), 0);
});

test("applies the days offset", () => {
  const base = new Date(2026, 0, 6, 10, 0, 0); // Tuesday
  const due = nextStepDueDate(base, 3, { hour: 9, skipWeekends: false });
  assert.equal(due.getDate(), 9); // Tue + 3 = Friday 2026-01-09
  assert.equal(due.getHours(), 9);
});

test("days offset of 0 keeps the same day at the configured hour", () => {
  const base = new Date(2026, 0, 6, 23, 30, 0); // Tuesday night
  const due = nextStepDueDate(base, 0, { hour: 9, skipWeekends: true });
  assert.equal(due.getDate(), 6); // same Tuesday
  assert.equal(due.getHours(), 9);
});

test("rolls a Saturday result forward to Monday when skipWeekends is on", () => {
  const base = new Date(2026, 0, 2, 23, 0, 0); // Friday
  const due = nextStepDueDate(base, 1, { hour: 9, skipWeekends: true });
  // Fri + 1 = Sat Jan 3 -> rolls to Mon Jan 5
  assert.equal(due.getDate(), 5);
  assert.equal(due.getDay(), 1); // Monday
  assert.equal(due.getHours(), 9);
});

test("rolls a Sunday result forward to Monday when skipWeekends is on", () => {
  const base = new Date(2026, 0, 3, 12, 0, 0); // Saturday
  const due = nextStepDueDate(base, 1, { hour: 9, skipWeekends: true });
  // Sat + 1 = Sun Jan 4 -> rolls to Mon Jan 5
  assert.equal(due.getDate(), 5);
  assert.equal(due.getDay(), 1); // Monday
});

test("does NOT roll off the weekend when skipWeekends is off", () => {
  const base = new Date(2026, 0, 2, 23, 0, 0); // Friday
  const due = nextStepDueDate(base, 1, { hour: 9, skipWeekends: false });
  assert.equal(due.getDate(), 3); // stays Saturday Jan 3
  assert.equal(due.getDay(), 6); // Saturday
  assert.equal(due.getHours(), 9);
});

test("clamps out-of-range hours to a valid 0-23 value", () => {
  const base = new Date(2026, 0, 6, 12, 0, 0);
  assert.equal(nextStepDueDate(base, 1, { hour: 99, skipWeekends: false }).getHours(), 23);
  assert.equal(nextStepDueDate(base, 1, { hour: -5, skipWeekends: false }).getHours(), 0);
});
