import test from "node:test";
import assert from "node:assert/strict";
import {
  FOLLOW_UP_TYPE,
  ensureFollowUpTime,
  followUpValidationError,
  isOpenFutureFollowUp,
} from "../src/lib/followUp";

const now = new Date("2026-07-20T10:00:00Z");
const future = new Date("2026-08-03T09:00:00Z");
const past = new Date("2026-07-01T09:00:00Z");

test("isOpenFutureFollowUp: an open, future follow-up suppresses the gone-quiet nudge", () => {
  assert.equal(
    isOpenFutureFollowUp(
      { type: FOLLOW_UP_TYPE, status: "planned", dueDate: future },
      now,
    ),
    true,
  );
});

test("isOpenFutureFollowUp: a past-due follow-up no longer suppresses", () => {
  assert.equal(
    isOpenFutureFollowUp(
      { type: FOLLOW_UP_TYPE, status: "planned", dueDate: past },
      now,
    ),
    false,
  );
});

test("isOpenFutureFollowUp: a completed/cancelled follow-up does not suppress", () => {
  assert.equal(
    isOpenFutureFollowUp(
      { type: FOLLOW_UP_TYPE, status: "done", dueDate: future },
      now,
    ),
    false,
  );
  assert.equal(
    isOpenFutureFollowUp(
      { type: FOLLOW_UP_TYPE, status: "canceled", dueDate: future },
      now,
    ),
    false,
  );
});

test("isOpenFutureFollowUp: other activity types never suppress, even open+future", () => {
  for (const type of ["call", "email", "todo", "test_drive", "meeting"]) {
    assert.equal(
      isOpenFutureFollowUp({ type, status: "planned", dueDate: future }, now),
      false,
      `${type} should not suppress`,
    );
  }
});

test("followUpValidationError: requires a note", () => {
  assert.match(
    followUpValidationError({ note: null, dueDate: future }, now) ?? "",
    /note/i,
  );
  assert.match(
    followUpValidationError({ note: "   ", dueDate: future }, now) ?? "",
    /note/i,
  );
});

test("followUpValidationError: requires a future, valid due date", () => {
  assert.match(
    followUpValidationError({ note: "call back", dueDate: past }, now) ?? "",
    /future/i,
  );
  assert.match(
    followUpValidationError({ note: "call back", dueDate: null }, now) ?? "",
    /valid future/i,
  );
  assert.match(
    followUpValidationError(
      { note: "call back", dueDate: new Date(NaN) },
      now,
    ) ?? "",
    /valid future/i,
  );
});

test("followUpValidationError: valid follow-up returns null", () => {
  assert.equal(
    followUpValidationError({ note: "will decide in 2 weeks", dueDate: future }, now),
    null,
  );
});

test("ensureFollowUpTime: keeps a real supplied time", () => {
  assert.equal(ensureFollowUpTime("2026-08-03T14:30"), "2026-08-03T14:30");
});

test("ensureFollowUpTime: replaces midnight with the default business hour", () => {
  assert.equal(ensureFollowUpTime("2026-08-03T00:00", 9), "2026-08-03T09:00");
});

test("ensureFollowUpTime: adds a real time to a date-only value", () => {
  assert.equal(ensureFollowUpTime("2026-08-03", 8), "2026-08-03T08:00");
});

test("ensureFollowUpTime: null in, null out", () => {
  assert.equal(ensureFollowUpTime(null), null);
});
