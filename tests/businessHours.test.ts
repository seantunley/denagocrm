import assert from "node:assert/strict";
import test from "node:test";
import { nextStepDueDate } from "../src/lib/businessHours";

// Africa/Johannesburg is a fixed UTC+2 (no DST). Due dates are computed and
// rendered in SAST, so we specify base moments with an explicit +02:00 offset
// and assert on SAST wall-clock parts — never the test machine's local zone.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;
function sastParts(d: Date) {
  const s = new Date(d.getTime() + SAST_OFFSET_MS);
  return {
    year: s.getUTCFullYear(),
    month: s.getUTCMonth(),
    day: s.getUTCDate(),
    dow: s.getUTCDay(), // 0 = Sunday, 6 = Saturday
    hour: s.getUTCHours(),
    minute: s.getUTCMinutes(),
    second: s.getUTCSeconds(),
    ms: s.getUTCMilliseconds(),
  };
}

// Reference calendar (2026): Jan 1 = Thursday, Jan 2 = Friday,
// Jan 3 = Saturday, Jan 4 = Sunday, Jan 5 = Monday, Jan 6 = Tuesday,
// Jan 7 = Wednesday.

test("09:00 SAST is stored as 07:00Z (built in Africa/Johannesburg time)", () => {
  const base = new Date("2026-01-06T23:09:42.500+02:00"); // Tue 23:09 SAST
  const due = nextStepDueDate(base, 1, { hour: 9, skipWeekends: true });
  // The raw UTC hour must be hour - 2, i.e. 07:00Z, which renders as 09:00 SAST.
  assert.equal(due.getUTCFullYear(), 2026);
  assert.equal(due.getUTCMonth(), 0);
  assert.equal(due.getUTCDate(), 7); // Wed 2026-01-07 (SAST day, same UTC day at 07:00Z)
  assert.equal(due.getUTCHours(), 7);
  assert.equal(due.getUTCMinutes(), 0);
  assert.equal(due.getUTCSeconds(), 0);
  assert.equal(due.getUTCMilliseconds(), 0);
});

test("normalises time-of-day to the configured SAST hour regardless of base time", () => {
  // A lead created late at night must not produce a task due late at night.
  const base = new Date("2026-01-06T23:09:42.500+02:00"); // Tue 23:09 SAST
  const p = sastParts(nextStepDueDate(base, 1, { hour: 9, skipWeekends: true }));
  assert.equal(p.year, 2026);
  assert.equal(p.month, 0);
  assert.equal(p.day, 7); // next SAST day, a Wednesday
  assert.equal(p.hour, 9);
  assert.equal(p.minute, 0);
  assert.equal(p.second, 0);
  assert.equal(p.ms, 0);
});

test("uses the SAST calendar day even when base is just after midnight SAST", () => {
  // 00:30 SAST is the previous UTC day (22:30Z) — proves the SAST day is used,
  // not the naive UTC date, regardless of the base's time-of-day.
  const base = new Date("2026-01-06T00:30:00+02:00"); // Tue 00:30 SAST
  const p = sastParts(nextStepDueDate(base, 0, { hour: 9, skipWeekends: true }));
  assert.equal(p.day, 6); // stays Tuesday Jan 6 in SAST
  assert.equal(p.hour, 9);
});

test("honours the configured hour value", () => {
  const base = new Date("2026-01-06T03:00:00+02:00"); // early morning SAST
  const due = nextStepDueDate(base, 1, { hour: 14, skipWeekends: false });
  assert.equal(due.getUTCHours(), 12); // 14:00 SAST == 12:00Z
  assert.equal(sastParts(due).hour, 14);
  assert.equal(sastParts(due).minute, 0);
});

test("applies the days offset in SAST", () => {
  const base = new Date("2026-01-06T10:00:00+02:00"); // Tuesday SAST
  const p = sastParts(nextStepDueDate(base, 3, { hour: 9, skipWeekends: false }));
  assert.equal(p.day, 9); // Tue + 3 = Friday 2026-01-09
  assert.equal(p.hour, 9);
});

test("days offset of 0 keeps the same SAST day when the hour is still ahead", () => {
  const base = new Date("2026-01-06T07:00:00+02:00"); // Tuesday 07:00 SAST, before 09:00
  const p = sastParts(nextStepDueDate(base, 0, { hour: 9, skipWeekends: true }));
  assert.equal(p.day, 6); // same Tuesday, 09:00 still in the future
  assert.equal(p.hour, 9);
});

test("days offset of 0 rolls to the next day once the configured hour has passed", () => {
  const base = new Date("2026-01-06T23:30:00+02:00"); // Tuesday night SAST, after 09:00
  const due = nextStepDueDate(base, 0, { hour: 9, skipWeekends: true });
  const p = sastParts(due);
  assert.equal(p.day, 7); // rolls forward to Wednesday
  assert.equal(p.hour, 9);
  assert.ok(due.getTime() > base.getTime(), "due must be in the future");
});

test("rolls a Saturday result forward to Monday when skipWeekends is on", () => {
  const base = new Date("2026-01-02T23:00:00+02:00"); // Friday SAST
  const p = sastParts(nextStepDueDate(base, 1, { hour: 9, skipWeekends: true }));
  // Fri + 1 = Sat Jan 3 -> rolls to Mon Jan 5
  assert.equal(p.day, 5);
  assert.equal(p.dow, 1); // Monday
  assert.equal(p.hour, 9);
});

test("rolls a Sunday result forward to Monday when skipWeekends is on", () => {
  const base = new Date("2026-01-03T12:00:00+02:00"); // Saturday SAST
  const p = sastParts(nextStepDueDate(base, 1, { hour: 9, skipWeekends: true }));
  // Sat + 1 = Sun Jan 4 -> rolls to Mon Jan 5
  assert.equal(p.day, 5);
  assert.equal(p.dow, 1); // Monday
});

test("does NOT roll off the weekend when skipWeekends is off", () => {
  const base = new Date("2026-01-02T23:00:00+02:00"); // Friday SAST
  const p = sastParts(nextStepDueDate(base, 1, { hour: 9, skipWeekends: false }));
  assert.equal(p.day, 3); // stays Saturday Jan 3
  assert.equal(p.dow, 6); // Saturday
  assert.equal(p.hour, 9);
});

test("clamps out-of-range hours to a valid 0-23 SAST value", () => {
  const base = new Date("2026-01-06T12:00:00+02:00");
  assert.equal(
    sastParts(nextStepDueDate(base, 1, { hour: 99, skipWeekends: false })).hour,
    23
  );
  assert.equal(
    sastParts(nextStepDueDate(base, 1, { hour: -5, skipWeekends: false })).hour,
    0
  );
});
