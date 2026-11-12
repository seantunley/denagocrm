import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { isOverdueActivity } from "../src/lib/activityDay";

const src = (rel: string) => readFileSync(rel, "utf8");

test("overdue: an all-day task once its day has passed, a timed one once its time has", () => {
  const noonSast = new Date("2026-11-06T10:00:00Z");
  const allDay = (iso: string) => ({ dueDate: new Date(iso), allDay: true });
  const timed = (iso: string) => ({ dueDate: new Date(iso), allDay: false });
  assert.equal(isOverdueActivity(allDay("2026-11-06T00:00:00Z"), noonSast), false, "all-day today is not overdue");
  assert.equal(isOverdueActivity(allDay("2026-11-05T00:00:00Z"), noonSast), true, "all-day yesterday is");
  assert.equal(isOverdueActivity(timed("2026-11-06T09:30:00Z"), noonSast), true, "timed, half an hour ago");
  assert.equal(isOverdueActivity(timed("2026-11-06T10:30:00Z"), noonSast), false, "timed, in half an hour");
  // 23:30 SAST is 21:30 UTC the same day: today's all-day task is still not overdue.
  assert.equal(isOverdueActivity(allDay("2026-11-06T00:00:00Z"), new Date("2026-11-06T21:30:00Z")), false);
  // A 02:00 SAST appointment sits at 00:00 UTC — it is timed, so it IS overdue at noon.
  assert.equal(isOverdueActivity(timed("2026-11-06T00:00:00Z"), noonSast), true, "timed at 02:00 SAST is not all-day");
});

test("the Activities page and the sidebar badge count overdue with the same rule", () => {
  assert.match(src("src/app/(app)/activities/page.tsx"), /isOverdueActivity\(activity, now\)/);
  const access = src("src/lib/activityAccess.ts");
  assert.match(access, /export async function overdueActivityCount/);
  assert.match(access, /assignedToId: user\.id/, "the page's default view is my own tasks");
  assert.match(access, /availabilityBlock: false/, "calendar availability is not a task");
  assert.match(access, /select: \{ dueDate: true, allDay: true \}/);
  assert.match(access, /isOverdueActivity\(row, now\)/);
  assert.match(src("src/components/AppShell.tsx"), /"\/activities": activitiesOverdue/);
});

test("the inbox badge counts the inbox's own channel list, X included", () => {
  assert.match(src("src/lib/inboxQuery.ts"), /export const DM_CHANNELS = \[[^\]]*"x"/);
  assert.match(src("src/lib/inboxCount.ts"), /import \{ DM_CHANNELS \} from "\.\/inboxQuery";/);
  assert.doesNotMatch(src("src/lib/inboxCount.ts"), /const DM_CHANNELS =/, "no second copy to drift");
});

test("a collapsed sidebar group shows the total of its badges", () => {
  assert.match(src("src/components/Nav.tsx"), /const hidden = expanded \? 0 : groupTotal\(group\);/);
  assert.match(src("src/components/Nav.tsx"), /const groupTotal = \(group: NavGroup\) => group\.links\.reduce/);
});

test("job card Delete is a text link under More, not a red button beside Print", () => {
  const page = src("src/app/(app)/jobcards/[id]/page.tsx");
  assert.doesNotMatch(page, /deleteJobCard[^\n]*btn-danger/);
  const more = page.slice(page.indexOf("More job card actions"));
  assert.match(more, /<PopoverContent[\s\S]*deleteJobCard\.bind/);
});

test("settings overview: cards only, search focused", () => {
  const workspace = src("src/components/settings-workspace.tsx");
  assert.match(workspace, /const overview = current === "overview";/);
  assert.match(workspace, /<SettingsFinder groups=\{shown\} autoFocus=\{overview\} \/>/);
  assert.match(workspace, /overview \? \(\s*<main/, "no side list on the overview");
});

test("the top bar shows one clock; date and the other cities on hover or focus", () => {
  const clock = src("src/components/ClockWeather.tsx");
  assert.match(clock, /group-hover:block group-focus-within:block/);
  assert.match(clock, /const home = cities\[0\];/);
});
