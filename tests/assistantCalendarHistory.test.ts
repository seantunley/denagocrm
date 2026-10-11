import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { activityArgs, planInstructions } from "../src/lib/crmAssistantPlan";

// crmAssistant.ts reaches server-only; its pure helpers load with it stubbed.
type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const realLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request, parent, isMain) {
  if (request === "server-only") return {};
  return realLoad.call(this, request, parent, isMain);
};

// Production, 2026-10-05: "What was on the calendar on 22nd September?" → "no
// appointments". The Excelsior Golf Day that day was a meeting marked DONE once
// it happened, and both calendar lookups only ever read "planned" activities —
// and find_activities couldn't look at a past date at all.
const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const lib = code("src/lib/crmAssistant.ts");
const fn = (name: string) => lib.slice(lib.indexOf(`async function ${name}(`), lib.indexOf("\n}\n", lib.indexOf(`async function ${name}(`)));

test("a past day or period can be asked about", () => {
  assert.equal(activityArgs.safeParse({ when: "past", from: "2026-09-22", to: "2026-09-22" }).success, true);
  assert.equal(activityArgs.safeParse({ when: "past", search: "golf" }).success, true);
  assert.equal(activityArgs.safeParse({ when: "past", from: "22 Sept" }).success, false);
  const plan = planInstructions({ today: "2026-10-06", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /What HAPPENED \("what golf days did we have last month", "what was on 22 September"\) → "past" with from\/to/);
});

test("BLOCKED TIME IS ON THE CALENDAR: a calendar question finds it — only the two work lists leave it out", () => {
  // "What is in my calendar this week?" answered "nothing" for someone whose Tuesday was blocked,
  // because this search — which the assistant is told IS the calendar — dropped blocked time always.
  const find = fn("findActivities");
  assert.match(find, /const workList = !dated && \(args\.when === "overdue" \|\| args\.when === "today_and_overdue"\);/);
  assert.match(find, /\.\.\.\(workList \? \{ availabilityBlock: false \} : \{\}\),/);
  assert.doesNotMatch(find, /status: history \? \{ notIn: CANCELLED \} : "planned",\s*availabilityBlock: false,/, "the unconditional exclusion is gone");
  // It is shown as what it is, with when it ends.
  assert.match(find, /type: a\.availabilityBlock \? "blocked time" : a\.type,/);
  assert.match(find, /\.\.\.\(a\.availabilityBlock \? \{ blockedTime: true \} : \{\}\),/);
  assert.match(find, /\.\.\.\(a\.allDay \? \{ allDay: true \} : \{ time: saLocal\(a\.dueDate\)\.slice\(11\) \}\),/);
  // An empty answer names the days it covered, and whether blocked time was looked for.
  assert.match(find, /if \(page\.length === 0\) \{/);
  assert.match(find, /Give those dates in your answer\./);
  assert.match(find, /\$\{workList \? "" : ", and no blocked time"\}/);
  assert.match(find, /const to = "lt" in window && window\.lt \? day\(new Date\(window\.lt\.getTime\(\) - 1\)\) : null;/, "the last day of the window, not the day after it");
  // And the assistant is told so when it chooses a lookup.
  const plan = planInstructions({ today: "2026-10-11", userName: "Sean", stages: [], staff: [], activityTypes: [] });
  assert.match(plan, /the calendar: calls, meetings, to-dos, test drives, events, and blocked time \(personal items: leave, an appointment, admin time\)/);
  assert.match(plan, /"What is in my calendar \/ diary this week" → this_week with assignedTo: today and the next six days, blocked time included — say which dates that covers\./);
});

test("looking back includes what was DONE — never what was cancelled (either spelling)", () => {
  assert.match(lib, /const CANCELLED = \["canceled", "cancelled"\];/);
  const find = fn("findActivities");
  assert.match(find, /const history = args\.when === "past" \|\| dated !== null;/);
  assert.match(find, /status: history \? \{ notIn: CANCELLED \} : "planned",/, "what's still to do stays planned-only");
  assert.match(find, /dueDate: dated \?\? range,/);
  assert.match(find, /args\.to \? \{ lt: new Date\(new Date\(`\$\{args\.to\}T00:00:00\+02:00`\)\.getTime\(\) \+ DAY\) \}/, "the whole last day");
  assert.match(find, /\.\.\.\(history \? \{ status: a\.status \} : \{\}\),/, "each result says planned or done");
  assert.match(find, /\.\.\.\(a\.status === "planned" && a\.dueDate < startOfToday \? \{ overdue: true \} : \{\}\),/, "a done meeting isn't 'overdue'");
});

/* ── schedule is the AVAILABILITY tool (#782 review) ──────────────────────── */

// The real filter, evaluated against rows: just enough of Prisma's where.
type Row = { status: string; dueDate: Date; endDate: Date | null };
function matches(row: Row, where: unknown): boolean {
  const w = where as Record<string, unknown>;
  return Object.entries(w).every(([key, cond]) => {
    if (key === "OR") return (cond as unknown[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as unknown[]).every((c) => matches(row, c));
    const actual = (row as Record<string, unknown>)[key];
    if (cond === null) return actual === null;
    if (cond && typeof cond === "object" && "lt" in cond) return actual instanceof Date && actual < (cond as { lt: Date }).lt;
    return actual === cond;
  });
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadLib = () => require("../src/lib/crmAssistant") as typeof import("../src/lib/crmAssistant");

test("a meeting later today marked done EARLY is not busy time — DAX must not refuse that free slot", async () => {
  const { scheduleStatusWhere } = loadLib();
  const now = new Date("2026-10-06T08:00:00Z");
  const laterToday = new Date("2026-10-06T12:00:00Z");
  assert.equal(matches({ status: "done", dueDate: laterToday, endDate: new Date("2026-10-06T13:00:00Z") }, scheduleStatusWhere(now)), false);
  assert.equal(matches({ status: "done", dueDate: laterToday, endDate: null }, scheduleStatusWhere(now)), false);
  // …nor one that started but was finished before its end time.
  assert.equal(matches({ status: "done", dueDate: new Date("2026-10-06T07:30:00Z"), endDate: new Date("2026-10-06T09:00:00Z") }, scheduleStatusWhere(now)), false);
});

test("the same completed activity in a past window is history, and is shown", async () => {
  const { scheduleStatusWhere } = loadLib();
  const now = new Date("2026-10-06T08:00:00Z");
  // Excelsior Golf Day, 22 September — done.
  assert.equal(matches({ status: "done", dueDate: new Date("2026-09-22T07:00:00Z"), endDate: null }, scheduleStatusWhere(now)), true);
  assert.equal(matches({ status: "done", dueDate: new Date("2026-09-22T07:00:00Z"), endDate: new Date("2026-09-22T12:00:00Z") }, scheduleStatusWhere(now)), true);
});

test("a planned activity in the same window still blocks; cancelled never shows (either spelling)", async () => {
  const { scheduleStatusWhere } = loadLib();
  const now = new Date("2026-10-06T08:00:00Z");
  const laterToday = new Date("2026-10-06T12:00:00Z");
  assert.equal(matches({ status: "planned", dueDate: laterToday, endDate: null }, scheduleStatusWhere(now)), true);
  assert.equal(matches({ status: "planned", dueDate: new Date("2026-09-22T07:00:00Z"), endDate: null }, scheduleStatusWhere(now)), true, "a missed one still shows on its day");
  for (const status of ["canceled", "cancelled"]) {
    assert.equal(matches({ status, dueDate: laterToday, endDate: null }, scheduleStatusWhere(now)), false);
    assert.equal(matches({ status, dueDate: new Date("2026-09-22T07:00:00Z"), endDate: null }, scheduleStatusWhere(now)), false);
  }
});

test("schedule uses that filter, and marks each row's status (blocked time stays just 'busy')", () => {
  const sched = fn("schedule");
  assert.match(sched, /AND: \[\s*scheduleStatusWhere\(new Date\(\)\),/);
  assert.doesNotMatch(sched, /status: \{ notIn: CANCELLED \}/, "not 'anything not cancelled' any more");
  assert.match(sched, /\.\.\.\(a\.availabilityBlock \? \{\} : \{ status: a\.status \}\),/);
});
