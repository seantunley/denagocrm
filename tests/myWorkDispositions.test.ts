import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DISMISSABLE_SOURCES, applyDispositions, parseItemKey, snoozeUntil } from "../src/lib/myWork/dispositions";
import type { WorkItem } from "../src/lib/myWork/rules";

/** Brief §6: snooze and dismiss on My Work — never hiding an unresolved obligation for good. */
const NOW = new Date("2026-11-24T10:00:00+02:00");
const item = (type: WorkItem["source"]["type"], id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  area: "Sales",
  source: { type, id },
  kind: type === "lead" || type === "quote" ? "suggestion" : "task",
  title: id,
  reason: "No contact for 9 days",
  due: null,
  href: "/",
  ...over,
});

test("a snoozed item leaves my list until the day I picked, then comes back", () => {
  const until = snoozeUntil(1, NOW);
  assert.equal(until.toISOString(), "2026-11-24T22:00:00.000Z", "back at the start of tomorrow, Johannesburg");
  const items = [item("activity", "a"), item("case", "b")];
  const { shown, snoozed } = applyDispositions(items, [{ itemKey: "activity:a", action: "snoozed", until, fingerprint: null }], NOW);
  assert.deepEqual(shown.map((i) => i.source.id), ["b"]);
  assert.deepEqual(snoozed.map((i) => i.source.id), ["a"]);
  // After the snooze ends it is simply back.
  const later = new Date(until.getTime() + 1);
  assert.equal(applyDispositions(items, [{ itemKey: "activity:a", action: "snoozed", until, fingerprint: null }], later).shown.length, 2);
});

test("a dismissed suggestion comes back when its reason changes; a task cannot be dismissed away", () => {
  const until = new Date(NOW.getTime() + 30 * 86_400_000);
  const dismissed = [{ itemKey: "lead:x", action: "dismissed", until, fingerprint: "No contact for 9 days" }];
  assert.equal(applyDispositions([item("lead", "x")], dismissed, NOW).shown.length, 0);
  assert.equal(applyDispositions([item("lead", "x", { reason: "Replied on WhatsApp" })], dismissed, NOW).shown.length, 1, "a new reason is a new suggestion");
  // Even a stray dismissed row never hides a TASK.
  const onTask = [{ itemKey: "activity:t", action: "dismissed", until, fingerprint: "No contact for 9 days" }];
  assert.equal(applyDispositions([item("activity", "t")], onTask, NOW).shown.length, 1);
  assert.deepEqual([...DISMISSABLE_SOURCES].sort(), ["lead", "quote"]);
});

test("only a well-formed item key is accepted", () => {
  assert.deepEqual(parseItemKey("lead:abc123"), { type: "lead", key: "lead:abc123" });
  assert.equal(parseItemKey("lead:"), null);
  assert.equal(parseItemKey("user:abc"), null);
  assert.equal(parseItemKey("lead:abc; drop"), null);
});

test("the action works on MY list only, refuses dismissing a task, and never writes the record", () => {
  const action = readFileSync("src/app/actions/myWork.ts", "utf8");
  assert.match(action, /withActingStaffScope/);
  assert.match(action, /await requireModuleEnabled\("work"\)/);
  assert.match(action, /tenantId_userId_itemKey: \{ tenantId, userId: user\.id, itemKey: item\.key \}/);
  assert.match(action, /if \(!DISMISSABLE_SOURCES\.has\(item\.type\)\) return \{ error:/);
  // It touches its own table and nothing else.
  for (const model of ["activity", "lead", "quote", "customerCase", "jobCard", "approvalStep"]) assert.doesNotMatch(action, new RegExp(`prisma\\.${model}\\.`), model);
  // The table: one row per person per item, isolated per workspace.
  const sql = readFileSync("prisma/migrations/20261124200000_work_disposition/migration.sql", "utf8");
  assert.match(sql, /ALTER TABLE "WorkDisposition" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /ALTER TABLE "WorkDisposition" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /"WorkDisposition_tenantId_userId_itemKey_key"/);
});

test("Team is counts only, for the workspace owner", () => {
  const extras = readFileSync("src/lib/myWork/extras.ts", "utf8");
  assert.match(extras, /if \(user\.role !== "owner"\) return null;/);
  assert.doesNotMatch(extras.slice(extras.indexOf("export async function teamWorkload")), /findMany/, "no record content, only counts");
});
