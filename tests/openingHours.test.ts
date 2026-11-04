import assert from "node:assert/strict";
import { test } from "node:test";
import { isOpenAt } from "../src/lib/openingHours";
import { DEFAULT_HOLIDAYS, holidaysFor, isHoliday, missingYears, parseHolidaySetting, saPublicHolidays } from "../src/lib/publicHolidays";

const at = (sast: string) => new Date(`${sast}+02:00`);
const office = { hours: "08:00-17:00", days: "1,2,3,4,5" };

test("South African public holidays: fixed days, Easter-based days, and Sunday → Monday", () => {
  const y2026 = saPublicHolidays(2026);
  assert.equal(y2026.get("2026-04-03"), "Good Friday");
  assert.equal(y2026.get("2026-04-06"), "Family Day");
  assert.equal(y2026.get("2026-12-16"), "Day of Reconciliation");
  assert.equal(y2026.get("2026-08-10"), "National Women's Day (observed)", "9 August 2026 is a Sunday");
  const y2027 = saPublicHolidays(2027);
  assert.equal(y2027.get("2027-03-26"), "Good Friday");
  assert.equal(y2027.get("2027-03-29"), "Family Day");
  // 2027: Human Rights Day and Day of Goodwill fall on Sundays; Christmas on a Saturday adds nothing.
  assert.equal(y2027.get("2027-03-22"), "Human Rights Day (observed)");
  assert.equal(y2027.get("2027-12-27"), "Day of Goodwill (observed)");
  assert.equal(y2027.size, 14);
});

test("the workspace setting: South Africa built in, another country as loaded, its own closed days on top", () => {
  assert.equal(parseHolidaySetting(null), DEFAULT_HOLIDAYS);
  assert.equal(parseHolidaySetting("not json"), DEFAULT_HOLIDAYS);
  const za = parseHolidaySetting(JSON.stringify({ country: "ZA", countryName: "South Africa", custom: [{ date: "2026-12-31", name: "Year-end shutdown" }] }));
  assert.ok(isHoliday(za, "2026-12-16"), "built in");
  assert.ok(isHoliday(za, "2026-12-31"), "the workspace's own closed day");
  assert.equal(holidaysFor(za, 2026).at(-1)?.custom, true);
  assert.deepEqual(missingYears(za, [2026, 2027]), [], "South Africa never needs loading");

  const gb = parseHolidaySetting(JSON.stringify({ country: "GB", countryName: "United Kingdom", loaded: { "2026": [{ date: "2026-12-28", name: "Boxing Day (substitute)" }] }, custom: [] }));
  assert.ok(isHoliday(gb, "2026-12-28"));
  assert.ok(!isHoliday(gb, "2026-12-16"), "not South Africa's");
  assert.deepEqual(missingYears(gb, [2026, 2027]), [2027]);
  // Junk in a saved list is dropped, not trusted.
  assert.deepEqual(parseHolidaySetting(JSON.stringify({ country: "GB", custom: [{ date: "31/12/2026", name: "x" }, { date: "2026-12-31" }] })).custom, []);
});

test("open inside the office hours on an office day; closed outside, at weekends and on holidays when asked", () => {
  const za = parseHolidaySetting(JSON.stringify({ country: "ZA", custom: [] }));
  const holidays = { isHoliday: (k: string) => isHoliday(za, k) };
  assert.equal(isOpenAt(at("2026-11-03T09:30:00"), office), true, "Tuesday morning");
  assert.equal(isOpenAt(at("2026-11-03T07:59:00"), office), false, "before opening");
  assert.equal(isOpenAt(at("2026-11-03T17:00:00"), office), false, "closing time is closed");
  assert.equal(isOpenAt(at("2026-11-07T10:00:00"), office), false, "Saturday");
  assert.equal(isOpenAt(at("2026-11-07T10:00:00"), { hours: "08:00-13:00", days: "1,2,3,4,5,6" }), true, "Saturday mornings when chosen");
  assert.equal(isOpenAt(at("2026-12-16T10:00:00"), office, holidays), false, "Day of Reconciliation");
  assert.equal(isOpenAt(at("2026-12-16T10:00:00"), office), true, "holidays not asked about");
  assert.equal(isOpenAt(at("2026-11-03T09:30:00"), {}), true, "nothing saved: Mon–Fri 08:00–17:00");
  // Midnight in Johannesburg is still the previous day in UTC: the day is read in Johannesburg.
  assert.equal(isOpenAt(new Date("2026-11-02T23:30:00Z"), { hours: "00:00-23:59", days: "2" }), true, "01:30 Tuesday SAST");
});
