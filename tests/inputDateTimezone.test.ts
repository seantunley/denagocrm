import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { formatDateTime, inputDateTimeValue, inputDateValue } from "../src/lib/format";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE BUG THIS COVERS.
 *
 * A test drive booked for 10:00 showed "10:00" in the summary tile and "08:00"
 * in the form field directly beneath it. It read as the form resetting itself to
 * a default of 08:00–09:00. It was not a default: it was the same instant,
 * printed in two different timezones.
 *
 *   the tile   formatDateTime()                     pinned to Africa/Johannesburg
 *   the field  date-fns format(d, "…'T'HH:mm")      the SERVER's zone — UTC on Vercel
 *
 * The display was the harmless half. app/actions/testDrives.ts parses a
 * submitted value as +02:00, so pressing "Save booking" without touching the
 * time took the 08:00 the field had been seeded with, read it as 08:00 SAST, and
 * stored a booking two hours earlier than the one that was already there. Every
 * save walked the appointment backwards by the offset.
 *
 * These tests run with TZ unset — whatever the machine happens to be — precisely
 * because the old code was correct only on a machine already set to SAST.
 */

/** 10:00 in Johannesburg is 08:00 UTC. */
const TEN_AM_SAST = new Date("2026-08-10T08:00:00.000Z");

test("a datetime-local value is Johannesburg time, not the server's", () => {
  assert.equal(inputDateTimeValue(TEN_AM_SAST), "2026-08-10T10:00");
});

test("the field and the tile above it agree", () => {
  // The whole visible symptom in one assertion: these two are rendered by
  // different functions from the same instant and must not disagree.
  const tile = formatDateTime(TEN_AM_SAST);
  const field = inputDateTimeValue(TEN_AM_SAST);
  assert.match(tile, /10:00/, `tile should read 10:00, got ${tile}`);
  assert.ok(field.endsWith("10:00"), `field should read 10:00, got ${field}`);
});

test("seeding a form and saving it unchanged does not move the booking", () => {
  // The corruption guard. `parse` mirrors localDateTime() in
  // app/actions/testDrives.ts — a bare value is read as +02:00.
  const parse = (value: string) => new Date(`${value}:00+02:00`);

  let instant = TEN_AM_SAST;
  for (let save = 0; save < 5; save++) {
    instant = parse(inputDateTimeValue(instant));
    assert.equal(
      instant.toISOString(),
      TEN_AM_SAST.toISOString(),
      `save ${save + 1} moved the booking to ${instant.toISOString()}`,
    );
  }
});

test("the write path still reads a bare value as +02:00", () => {
  // If this ever changes, the round-trip above is testing a rule the action no
  // longer follows, and it would keep passing while production drifted.
  const action = readFileSync(join(root, "src/app/actions/testDrives.ts"), "utf8");
  assert.match(
    action,
    /\$\{value\}:00\+02:00/,
    "localDateTime must still interpret a bare datetime-local value as SAST",
  );
});

test("neither test-drive page builds its own value with date-fns any more", () => {
  // The fault was duplicated across two pages, so a fix to one would have left
  // the other quietly wrong.
  for (const page of ["src/app/(app)/test-drives/page.tsx", "src/app/(app)/test-drives/[id]/page.tsx"]) {
    const source = readFileSync(join(root, page), "utf8");
    assert.doesNotMatch(
      source,
      /format\(\s*date\s*,\s*"yyyy-MM-dd'T'HH:mm"/,
      `${page} must use the pinned helper, not the server's timezone`,
    );
  }
});

test("a date-only field does not slip to the previous day", () => {
  // 00:30 SAST on the 10th is 22:30 UTC on the 9th. Formatted in UTC, a
  // date-only field would show the 9th.
  const justAfterMidnight = new Date("2026-08-09T22:30:00.000Z");
  assert.equal(inputDateValue(justAfterMidnight), "2026-08-10");
});

test("midnight renders as 00:00, never 24:00", () => {
  // Some ICU builds emit hour "24" with hour12:false, which is not a value an
  // input will accept.
  const midnightSast = new Date("2026-08-09T22:00:00.000Z");
  const value = inputDateTimeValue(midnightSast);
  assert.equal(value, "2026-08-10T00:00");
  assert.doesNotMatch(value, /T24:/);
});

test("empty and invalid inputs seed an empty field, not a crash", () => {
  assert.equal(inputDateTimeValue(null), "");
  assert.equal(inputDateTimeValue(undefined), "");
  assert.equal(inputDateTimeValue(new Date("nonsense")), "");
  assert.equal(inputDateValue(null), "");
});
