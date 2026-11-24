import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { daysSince, worklistOrderBy, worklistSort, worklistView, worklistWhere } from "../src/lib/salesWorklistRules";

/** Brief §2 (denagocrm-intelligent-workspaces-revised.md); Sean 2026-11-24: board stays the default, list per person. */
const NOW = new Date("2026-11-24T10:00:00+02:00");
const src = (rel: string) => readFileSync(rel, "utf8");

test("a bare /leads/list is My priorities; an old link with filters still shows everything it matched", () => {
  assert.equal(worklistView(undefined, false), "priorities");
  assert.equal(worklistView(undefined, true), "all");
  assert.equal(worklistView("waiting", true), "waiting");
  assert.equal(worklistView("nonsense", false), "priorities");
  assert.equal(worklistSort("value"), "value");
  assert.equal(worklistSort("drop table"), "");
});

test("each view is a filter on the real leads — open work only, except Nurturing and All", () => {
  assert.deepEqual(worklistWhere("all", NOW), {});
  assert.deepEqual(worklistWhere("nurture", NOW), { status: "nurture" });
  assert.deepEqual(worklistWhere("unassigned", NOW), { status: "open", assignedToId: null });
  const overdue = worklistWhere("overdue", NOW) as { activities: { some: { dueDate: { lt: Date }; availabilityBlock: boolean } } };
  assert.equal(overdue.activities.some.dueDate.lt, NOW);
  assert.equal(overdue.activities.some.availabilityBlock, false, "a staff leave block is not a deal's task");
  // Today = the Johannesburg day, midnight to midnight.
  const today = worklistWhere("today", NOW) as { activities: { some: { dueDate: { gte: Date; lt: Date } } } };
  assert.equal(today.activities.some.dueDate.gte.toISOString(), "2026-11-23T22:00:00.000Z");
  assert.equal(today.activities.some.dueDate.lt.toISOString(), "2026-11-24T22:00:00.000Z");
  const waiting = worklistWhere("waiting", NOW) as { quotes: { some: Record<string, unknown> } };
  assert.deepEqual(waiting.quotes.some, { status: "sent", signedAt: null, supersededAt: null, deletedAt: null });
  assert.deepEqual(worklistOrderBy("stage"), [{ stageEnteredAt: "asc" }, { id: "asc" }]);
  assert.equal(daysSince(new Date("2026-11-12T10:00:00+02:00"), NOW), 12);
});

test("the list page: a view only ever NARROWS the filters and access, and paging and per-currency totals hold", () => {
  const page = src("src/app/(app)/leads/list/page.tsx");
  assert.match(page, /AND: \[filtersWhere, worklistWhere\(view, now\), \.\.\.\(ranked \? \[\{ id: \{ in: ranked\.map\(\(row\) => row\.id\) \} \}\] : \[\]\)\]/);
  assert.match(page, /\.\.\.\(accessibleIds \? \{ id: \{ in: accessibleIds \} \} : \{\}\)/);
  assert.match(page, /prisma\.lead\.groupBy\(\{ by: \["currency"\], where, _sum: \{ valueCents: true \} \}\)/);
  assert.match(page, /pageWindow\(parsePage\(params\.page\), total\)/);
  // Rankings and reasons come from Today and the Attention Centre, not a second scorer.
  const loader = src("src/lib/salesWorklist.ts");
  assert.match(loader, /loadTodayLeads\(user, \{ mine: true \}, now\)/);
  assert.match(loader, /loadAttentionList\(user, now\)/);
});

test("board or list is remembered per person; the board is the default", () => {
  const pref = src("src/lib/leadsViewPreference.ts");
  assert.match(pref, /=== "list" \? "list" : "board"/);
  assert.match(pref, /`LEADS_VIEW:\$\{userId\}`/);
  const board = src("src/app/(app)/leads/page.tsx");
  const guard = board.indexOf('requireAnyPermission("leads.view_all", "leads.view_owned")');
  const jump = board.indexOf('=== "list") redirect("/leads/list")');
  assert.ok(guard > 0 && jump > guard, "the permission guard runs before the redirect");
  assert.match(board, /switchLeadsView\.bind\(null, "list"\)/);
  assert.match(src("src/app/(app)/leads/list/page.tsx"), /switchLeadsView\.bind\(null, "board"\)/);
  const action = src("src/app/actions/leadsView.ts");
  assert.match(action, /withActingStaffScope/);
  assert.match(action, /requireAnyPermission\("leads\.view_all", "leads\.view_owned"\)/);
});
