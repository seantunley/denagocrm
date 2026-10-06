import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { activityArgs, planInstructions } from "../src/lib/crmAssistantPlan";

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

test("the day's schedule shows done meetings too, marked, and never cancelled ones", () => {
  const sched = fn("schedule");
  assert.match(sched, /status: \{ notIn: CANCELLED \},/);
  assert.doesNotMatch(sched, /status: "planned"/);
  assert.match(sched, /\.\.\.\(a\.availabilityBlock \? \{\} : \{ status: a\.status \}\),/, "blocked time still shows only as busy");
});
