import test from "node:test";
import assert from "node:assert/strict";
import { compareTimelineItems } from "../src/lib/timelineOrdering";

test("pinned entries stay above pending and recent entries", () => {
  const items = [
    { id: "recent", when: new Date("2026-07-17T18:00:00Z") },
    {
      id: "pending",
      pending: true,
      when: new Date("2026-07-18T08:00:00Z"),
    },
    {
      id: "pinned",
      pinnedAt: new Date("2026-07-17T12:00:00Z"),
      when: new Date("2026-07-10T08:00:00Z"),
    },
  ];

  items.sort(compareTimelineItems);
  assert.deepEqual(
    items.map((item) => item.id),
    ["pinned", "pending", "recent"],
  );
});

test("recently pinned entries appear first within the pinned group", () => {
  const items = [
    {
      id: "older-pin",
      pinnedAt: new Date("2026-07-17T10:00:00Z"),
      when: new Date("2026-07-17T18:00:00Z"),
    },
    {
      id: "newer-pin",
      pinnedAt: new Date("2026-07-17T11:00:00Z"),
      when: new Date("2026-07-01T08:00:00Z"),
    },
  ];

  items.sort(compareTimelineItems);
  assert.deepEqual(
    items.map((item) => item.id),
    ["newer-pin", "older-pin"],
  );
});
