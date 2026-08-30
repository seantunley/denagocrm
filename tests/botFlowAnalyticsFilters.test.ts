import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsOccurredFrom, normalizeBotAnalyticsFilters } from "../src/lib/botFlowAnalyticsFilters";

const now = new Date("2026-08-30T21:15:00.000Z");
const versions = ["v3", "v2", "v1"];

test("analytics filters default to the latest immutable version and 30 UTC days", () => {
  const filters = normalizeBotAnalyticsFilters({}, versions, now);
  assert.equal(filters.versionId, "v3");
  assert.equal(filters.rangeDays, 30);
  assert.equal(filters.channel, null);
  assert.equal(filters.occurredFrom.toISOString(), "2026-08-01T00:00:00.000Z");
});

test("analytics filters accept only supported versions, ranges, and channels", () => {
  assert.deepEqual(normalizeBotAnalyticsFilters({ version: "v2", range: "7", channel: "telegram" }, versions, now), {
    versionId: "v2",
    rangeDays: 7,
    channel: "telegram",
    occurredFrom: new Date("2026-08-24T00:00:00.000Z"),
  });

  const invalid = normalizeBotAnalyticsFilters({ version: "other-tenant-version", range: "365", channel: "email" }, versions, now);
  assert.equal(invalid.versionId, "v3");
  assert.equal(invalid.rangeDays, 30);
  assert.equal(invalid.channel, null);
});

test("analytics ranges include today and begin at midnight UTC", () => {
  assert.equal(analyticsOccurredFrom(90, now).toISOString(), "2026-06-02T00:00:00.000Z");
});
