import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, summariseViews } from "../src/lib/signing/viewAnalytics";

test("empty views summarise to zeros", () => {
  const s = summariseViews([]);
  assert.equal(s.sessions, 0);
  assert.equal(s.totalSeconds, 0);
  assert.equal(s.firstOpened, null);
});

test("summary adds sessions and caps a single row at 30 minutes", () => {
  const s = summariseViews([
    { startedAt: new Date("2026-10-01T10:00:00Z"), lastSeenAt: new Date("2026-10-01T10:04:00Z"), seconds: 240, maxPage: 2, sections: ["pricing"] },
    { startedAt: new Date("2026-10-01T11:00:00Z"), lastSeenAt: new Date("2026-10-01T11:02:00Z"), seconds: 5000, maxPage: 1, sections: ["terms"] },
  ]);
  assert.equal(s.sessions, 2);
  assert.equal(s.totalSeconds, 240 + 30 * 60);
  assert.equal(s.maxPage, 2);
  assert.deepEqual(s.sections, ["pricing", "terms"]);
});

test("duration formatting", () => {
  assert.equal(formatDuration(45), "45 sec");
  assert.equal(formatDuration(120), "2 min");
  assert.equal(formatDuration(3720), "1 hr 2 min");
});
