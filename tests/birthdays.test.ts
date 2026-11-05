import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { birthdayKeys, formatBirthday, nextDays, parseBirthday, saDate, turningAge } from "../src/lib/birthdays";

const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const now = new Date("2026-11-05T10:00:00Z");

test("a birthday is a real day and month, with an optional past year", () => {
  assert.deepEqual(parseBirthday({ day: "12", month: "3", year: "" }, now), { ok: true, value: { birthDay: 12, birthMonth: 3, birthYear: null } });
  assert.deepEqual(parseBirthday({ day: "12", month: "3", year: "1984" }, now), { ok: true, value: { birthDay: 12, birthMonth: 3, birthYear: 1984 } });
  assert.deepEqual(parseBirthday({}, now), { ok: true, value: { birthDay: null, birthMonth: null, birthYear: null } }, "blank clears it");
  assert.equal(parseBirthday({ day: "31", month: "4" }, now).ok, false, "April has no 31st");
  assert.equal(parseBirthday({ day: "12" }, now).ok, false, "a day needs a month");
  assert.equal(parseBirthday({ year: "1990" }, now).ok, false, "a year alone isn't a birthday");
  assert.equal(parseBirthday({ day: "1", month: "1", year: "2030" }, now).ok, false, "not in the future");
  assert.equal(parseBirthday({ day: "29", month: "2", year: "1985" }, now).ok, false, "1985 had no 29 February");
  assert.equal(parseBirthday({ day: "29", month: "2", year: "1984" }, now).ok, true);
  assert.equal(parseBirthday({ day: "29", month: "2" }, now).ok, true, "29 Feb without a year is fine");
});

test("days are South African, and a leap-day birthday is kept on 28 February in other years", () => {
  assert.deepEqual(saDate(new Date("2026-11-05T22:30:00Z")), { year: 2026, month: 11, day: 6 }, "00:30 in SA is already the 6th");
  assert.deepEqual(birthdayKeys([{ year: 2027, month: 2, day: 28 }]), [{ month: 2, day: 28 }, { month: 2, day: 29 }]);
  assert.deepEqual(birthdayKeys([{ year: 2028, month: 2, day: 28 }]), [{ month: 2, day: 28 }], "a leap year has its own 29th");
  const week = nextDays(7, 1, new Date("2026-12-28T10:00:00Z"));
  assert.deepEqual(week.map((d) => `${d.month}/${d.day}`), ["12/29", "12/30", "12/31", "1/1", "1/2", "1/3", "1/4"], "across the new year");
  assert.equal(week[3].year, 2027);
});

test("how a birthday reads", () => {
  assert.equal(formatBirthday({ birthDay: 12, birthMonth: 3, birthYear: null }), "12 March");
  assert.equal(formatBirthday({ birthDay: 12, birthMonth: 3, birthYear: 1984 }), "12 March 1984");
  assert.equal(formatBirthday({ birthDay: null, birthMonth: null, birthYear: null }), null);
  assert.equal(turningAge({ birthDay: 12, birthMonth: 3, birthYear: 1984 }, 2027), 43);
  assert.equal(turningAge({ birthDay: 12, birthMonth: 3, birthYear: null }, 2027), null);
});

test("only customers the person may open, and other forms never wipe a saved birthday", () => {
  const server = read("src/lib/birthdaysServer.ts");
  assert.match(server, /hasAnyPermission\(user, "contacts\.view_all", "contacts\.view_owned"\)/);
  assert.match(server, /const ids = await getAccessibleContactIds\(user\);\s*if \(ids !== null && ids\.length === 0\) return \[\];/, "an empty list is nobody");
  assert.match(server, /\.\.\.\(ids === null \? \{\} : \{ id: \{ in: ids \} \}\)/);
  const actions = read("src/app/actions/contacts.ts");
  assert.match(actions, /if \(!formData\.has\("birthMonth"\)\) return \{\};/, "DAX's customer cards and contactFormFor send no birthday: leave it");
  assert.match(actions, /if \(!parsed\.ok\) refuse\(parsed\.error\);/);
  assert.match(read("src/lib/routeAccess.ts"), /\{ prefix: "\/birthdays", anyOf: \["contacts\.view_all", "contacts\.view_owned"\] \}/);
});

test("nothing is sent to a customer from the birthdays page", () => {
  const page = read("src/app/(app)/birthdays/page.tsx");
  assert.doesNotMatch(page, /sendWhatsApp|sendEmail|send\w*Action|"use server"/);
});
