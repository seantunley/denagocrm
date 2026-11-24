import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTION_LABEL, bucketOf, groupWork, priorityOf, rankWork, workKey, type WorkItem } from "../src/lib/myWork/rules";
import { MODULE_REGISTRY, OPTIONAL_MODULE_IDS, moduleForPath } from "../src/lib/modules/registry";
import { grantedModuleIds } from "../src/lib/modules/entitlement";

/** Brief §6 (denagocrm-intelligent-workspaces-revised.md), Sean 2026-11-24. */
const NOW = new Date("2026-11-24T10:00:00+02:00");
const item = (over: Partial<WorkItem>): WorkItem => ({
  area: "Sales",
  source: { type: "activity", id: Math.random().toString(36) },
  kind: "task",
  title: "x",
  reason: "y",
  due: null,
  href: "/",
  ...over,
});

test("days are Johannesburg days; a timed item is late once its time has gone, an all-day one once its day has", () => {
  assert.equal(bucketOf(item({ due: new Date("2026-11-24T09:00:00+02:00") }), NOW), "overdue");
  assert.equal(bucketOf(item({ due: new Date("2026-11-24T09:00:00+02:00"), allDay: true }), NOW), "today");
  assert.equal(bucketOf(item({ due: new Date("2026-11-24T15:00:00+02:00") }), NOW), "today");
  assert.equal(bucketOf(item({ due: new Date("2026-11-23T23:30:00+02:00"), allDay: true }), NOW), "overdue");
  // 23:30 UTC on the 24th is already the 25th in Johannesburg.
  assert.equal(bucketOf(item({ due: new Date("2026-11-24T23:30:00Z") }), NOW), "upcoming");
  assert.equal(bucketOf(item({ due: null }), NOW), "undated");
  assert.equal(bucketOf(item({ due: new Date("2026-11-20T00:00:00+02:00"), waiting: true }), NOW), "waiting", "waiting on someone else is never my overdue");
});

test("one row per record, urgent first, then soonest", () => {
  const a = item({ source: { type: "case", id: "1" } });
  const groups = groupWork(
    [
      a,
      { ...a, title: "the same case again" },
      item({ source: { type: "jobcard", id: "2" }, area: "Workshop" }),
      item({ source: { type: "jobcard", id: "3" }, area: "Workshop", urgent: true }),
    ],
    NOW,
  );
  // Urgent first; then (no dates) by area, Sales before Workshop.
  assert.deepEqual(groups.undated.map(workKey), ["jobcard:3", "case:1", "jobcard:2"]);
});

test("one list, most pressing first; priority from facts — urgent or late is High", () => {
  const ranked = rankWork(
    [
      item({ source: { type: "case", id: "w" }, waiting: true }),
      item({ source: { type: "jobcard", id: "u" } }),
      item({ source: { type: "activity", id: "late" }, due: new Date("2026-11-23T09:00:00+02:00") }),
      item({ source: { type: "activity", id: "today" }, due: new Date("2026-11-24T15:00:00+02:00") }),
    ],
    NOW,
  );
  assert.deepEqual(ranked.map((r) => `${r.source.id}:${r.bucket}`), ["late:overdue", "today:today", "u:undated", "w:waiting"]);
  assert.deepEqual(ranked.map((r) => priorityOf(r, r.bucket)), ["High", "Medium", "Low", "Low"]);
  assert.equal(priorityOf(item({ urgent: true }), "undated"), "High");
  assert.equal(ACTION_LABEL.approval, "Approve");
});

test("its own module, off until a workspace is granted it (Denago only while testing)", () => {
  const mod = MODULE_REGISTRY.find((m) => m.id === "work");
  assert.ok(mod && OPTIONAL_MODULE_IDS.includes("work"));
  assert.equal(moduleForPath("/work"), "work");
  assert.equal(grantedModuleIds("inbox,support,automotive").has("work"), false);
  assert.equal(grantedModuleIds("work").has("work"), true);
  assert.match(readFileSync("src/app/(app)/work/page.tsx", "utf8"), /await requireModuleEnabled\("work"\);/);
});

test("every source asks its own page's permission, and module, before reading", () => {
  const load = readFileSync("src/lib/myWork/load.ts", "utf8");
  for (const gate of [
    /hasAnyPermission\(user, "leads\.view_all", "leads\.view_owned"\)/,
    /hasAnyPermission\(user, "activities\.view", "activities\.manage"\)/,
    /hasAnyPermission\(user, "quotes\.view_all", "quotes\.view_owned"\)/,
    /hasAnyPermission\(user, "deliveries\.view", "deliveries\.manage"\)/,
    /hasAnyPermission\(user, "jobcards\.view_all", "jobcards\.view_owned"\)/,
    /hasAnyPermission\(user, "cases\.view_all", "cases\.view_owned"\)/,
    /hasAnyPermission\(user, "signing\.view", "signing\.manage"\)/,
    /modules\.has\("automotive"\) \? myDeliveries/,
    /modules\.has\("automotive"\) \? myJobCards/,
    /modules\.has\("support"\) \? myCases/,
  ]) assert.match(load, gate);
  // Narrowed to what the record's own list would show, not just "assigned to me".
  assert.equal(load.match(/\.\.\.within\(/g)?.length, 4);
});
