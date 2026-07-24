import test from "node:test";
import assert from "node:assert/strict";
import { classifyRetry, isCommunicationQuietHour } from "../src/lib/communicationPolicy";

test("classifies retryable and permanent provider failures", () => {
  assert.equal(classifyRetry(1), "failed_temporary");
  assert.equal(classifyRetry(2), "failed_temporary");
  assert.equal(classifyRetry(3), "failed_permanent");
});

test("enforces South African marketing quiet hours", () => {
  assert.equal(isCommunicationQuietHour(new Date("2026-07-24T17:00:00.000Z")), false); // 19:00 SAST
  assert.equal(isCommunicationQuietHour(new Date("2026-07-24T08:00:00.000Z")), false); // 10:00 SAST
  assert.equal(isCommunicationQuietHour(new Date("2026-07-24T19:30:00.000Z")), true); // 21:30 SAST
  assert.equal(isCommunicationQuietHour(new Date("2026-07-24T04:00:00.000Z")), true); // 06:00 SAST
});
