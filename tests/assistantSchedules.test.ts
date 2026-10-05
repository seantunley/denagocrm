import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  MAX_ACTIVE_SCHEDULES,
  SCHEDULE_SKIPPED_NOTE,
  describeSchedule,
  nextRun,
  scheduleFailureNote,
  scheduleInput,
  snapToHalfHour,
  type ScheduleTiming,
} from "../src/lib/assistantSchedule";
import { splitActions } from "../src/lib/assistantActions";

const code = (rel: string) =>
  readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

// 2026-10-05 is a Monday. South Africa is UTC+02:00 all year, so 07:00 there is 05:00Z.
const at = (iso: string) => new Date(iso);
const next = (s: ScheduleTiming, after: string) => nextRun(s, at(after))?.toISOString() ?? null;

test("daily: later today, or tomorrow once the time has gone — never the same instant twice", () => {
  const daily = { cadence: "daily", timeOfDay: "07:00" };
  assert.equal(next(daily, "2026-10-05T04:59:00Z"), "2026-10-05T05:00:00.000Z", "06:59 SA → 07:00 today");
  assert.equal(next(daily, "2026-10-05T05:00:00Z"), "2026-10-06T05:00:00.000Z", "exactly now → tomorrow (strictly after)");
  assert.equal(next(daily, "2026-10-05T05:00:00.001Z"), "2026-10-06T05:00:00.000Z");
});

test("the day is South Africa's, not UTC's", () => {
  // 23:30Z on the 5th is already 01:30 on the 6th in South Africa.
  assert.equal(next({ cadence: "daily", timeOfDay: "00:30" }, "2026-10-05T23:30:00Z"), "2026-10-06T22:30:00.000Z");
  assert.equal(next({ cadence: "daily", timeOfDay: "07:00" }, "2026-10-05T23:30:00Z"), "2026-10-06T05:00:00.000Z");
  assert.equal(next({ cadence: "daily", timeOfDay: "00:00" }, "2026-10-05T12:00:00Z"), "2026-10-05T22:00:00.000Z", "midnight SA is 22:00Z the day before");
  // Monday 01:00 SA is still Sunday in UTC: a Monday schedule is TODAY.
  assert.equal(next({ cadence: "weekly", weekday: 1, timeOfDay: "07:00" }, "2026-10-04T23:00:00Z"), "2026-10-05T05:00:00.000Z");
});

test("month and year roll over", () => {
  assert.equal(next({ cadence: "daily", timeOfDay: "07:00" }, "2026-10-31T06:00:00Z"), "2026-11-01T05:00:00.000Z");
  assert.equal(next({ cadence: "daily", timeOfDay: "07:00" }, "2026-12-31T06:00:00Z"), "2027-01-01T05:00:00.000Z");
  // Thursday 31 Dec, weekly Monday → Monday 4 Jan 2027.
  assert.equal(next({ cadence: "weekly", weekday: 1, timeOfDay: "07:00" }, "2026-12-31T06:00:00Z"), "2027-01-04T05:00:00.000Z");
});

test("weekly: this week if still ahead, else the same day next week", () => {
  const monday7 = { cadence: "weekly", weekday: 1, timeOfDay: "07:00" };
  assert.equal(next(monday7, "2026-10-05T04:00:00Z"), "2026-10-05T05:00:00.000Z", "Monday 06:00 → today");
  assert.equal(next(monday7, "2026-10-05T06:00:00Z"), "2026-10-12T05:00:00.000Z", "Monday 08:00 → next Monday");
  assert.equal(next(monday7, "2026-10-08T10:00:00Z"), "2026-10-12T05:00:00.000Z", "Thursday → Monday");
  assert.equal(next({ cadence: "weekly", weekday: 0, timeOfDay: "18:00" }, "2026-10-10T10:00:00Z"), "2026-10-11T16:00:00.000Z", "Saturday → Sunday");
});

test("weekdays skip the weekend", () => {
  const weekdays = { cadence: "weekdays", timeOfDay: "08:30" };
  assert.equal(next(weekdays, "2026-10-09T07:00:00Z"), "2026-10-12T06:30:00.000Z", "Friday 09:00 → Monday");
  assert.equal(next(weekdays, "2026-10-10T07:00:00Z"), "2026-10-12T06:30:00.000Z", "Saturday → Monday");
  assert.equal(next(weekdays, "2026-10-11T23:00:00Z"), "2026-10-12T06:30:00.000Z", "Monday 01:00 SA → that morning");
  assert.equal(next(weekdays, "2026-10-06T05:00:00Z"), "2026-10-06T06:30:00.000Z", "Tuesday 07:00 → today");
});

test("once: its own date and time while still ahead, otherwise nothing", () => {
  const once = { cadence: "once", onDate: "2026-10-09", timeOfDay: "09:00" };
  assert.equal(next(once, "2026-10-05T10:00:00Z"), "2026-10-09T07:00:00.000Z");
  assert.equal(next(once, "2026-10-09T07:00:00Z"), null, "exactly now has passed");
  assert.equal(next(once, "2026-10-10T07:00:00Z"), null, "in the past");
});

test("broken timing runs never — the runner switches it off rather than guessing", () => {
  const after = at("2026-10-05T10:00:00Z");
  for (const bad of [
    { cadence: "weekly", timeOfDay: "07:00" },
    { cadence: "weekly", weekday: 7, timeOfDay: "07:00" },
    { cadence: "daily", timeOfDay: "24:00" },
    { cadence: "daily", timeOfDay: "7:00" },
    { cadence: "hourly", timeOfDay: "07:00" },
    { cadence: "once", timeOfDay: "07:00" },
    { cadence: "once", onDate: "2026-02-30", timeOfDay: "07:00" },
  ]) {
    assert.equal(nextRun(bad, after), null, JSON.stringify(bad));
  }
});

test("what can be saved: a standalone question, a real time, weekday only weekly, date only once", () => {
  assert.deepEqual(scheduleInput.parse({ question: "  Which deals went quiet?  ", cadence: "weekly", weekday: 1, timeOfDay: "07:00" }), {
    question: "Which deals went quiet?", cadence: "weekly", weekday: 1, timeOfDay: "07:00",
  });
  assert.ok(scheduleInput.safeParse({ question: "Has Anna Jacobs signed?", cadence: "once", onDate: "2026-10-09", timeOfDay: "09:00" }).success);
  assert.ok(scheduleInput.safeParse({ question: "x", cadence: "weekdays", timeOfDay: "23:59" }).success);
  for (const bad of [
    { question: "", cadence: "daily", timeOfDay: "07:00" },
    { question: "   ", cadence: "daily", timeOfDay: "07:00" },
    { question: "x".repeat(301), cadence: "daily", timeOfDay: "07:00" },
    { question: "x", cadence: "daily", weekday: 1, timeOfDay: "07:00" },
    { question: "x", cadence: "weekly", timeOfDay: "07:00" },
    { question: "x", cadence: "daily", onDate: "2026-10-09", timeOfDay: "07:00" },
    { question: "x", cadence: "once", timeOfDay: "07:00" },
    { question: "x", cadence: "once", onDate: "2026-02-30", timeOfDay: "07:00" },
    { question: "x", cadence: "daily", timeOfDay: "24:00" },
    { question: "x", cadence: "hourly", timeOfDay: "07:00" },
    { question: "x", cadence: "daily", timeOfDay: "07:00", userId: "someone-else" },
  ]) {
    assert.equal(scheduleInput.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(MAX_ACTIVE_SCHEDULES, 10);
});

test("it reads plainly", () => {
  assert.equal(describeSchedule({ cadence: "weekly", weekday: 1, timeOfDay: "07:00" }), "Every Monday at 07:00");
  assert.equal(describeSchedule({ cadence: "weekdays", timeOfDay: "08:30" }), "Weekdays at 08:30");
  assert.equal(describeSchedule({ cadence: "daily", timeOfDay: "17:00" }), "Every day at 17:00");
  assert.equal(describeSchedule({ cadence: "once", onDate: "2026-10-09", timeOfDay: "09:00" }), "Once on Fri 9 Oct at 09:00");
});

test("a run that couldn't happen says why in general terms — never ChatGPT's own error", () => {
  assert.match(scheduleFailureNote("Connect ChatGPT first: Settings → Integrations → ChatGPT."), /ChatGPT isn't connected/);
  const other = scheduleFailureNote("ChatGPT didn't answer: upstream 502 at https://internal/abc");
  assert.match(other, /couldn't run this scheduled question/);
  assert.doesNotMatch(other, /502|internal/);
});

test("the assistant can propose a schedule — no lead, nothing extra", () => {
  const { actions } = splitActions(
    'Set up for you to confirm.\nACTIONS: [{"type":"schedule","question":"Which deals went quiet?","cadence":"weekly","weekday":1,"timeOfDay":"07:00"},{"type":"schedule","question":"x","cadence":"daily","timeOfDay":"07:00","leadId":"cmabcdefghijklmnopqrstuv"},{"type":"schedule","question":"x","cadence":"daily","timeOfDay":"07:00","userId":"u2"}]',
  );
  assert.deepEqual(actions, [{ type: "schedule", question: "Which deals went quiet?", cadence: "weekly", weekday: 1, timeOfDay: "07:00" }]);
  const instructions = code("src/lib/assistantActions.ts");
  assert.match(instructions, /the question must stand alone — name the customer or thing/);
  // Becoming a card: the cross-field rules and a future time are checked; no lead is looked up.
  const lib = code("src/lib/crmAssistant.ts");
  const resolve = lib.slice(lib.indexOf("async function resolveActions"), lib.indexOf("function dedupeRows"));
  const schedule = resolve.slice(resolve.indexOf('if (p.type === "schedule")'), resolve.indexOf("canAccessLead"));
  assert.match(schedule, /scheduleInput\.safeParse\(fields\)/);
  assert.match(schedule, /!nextRun\(parsed\.data, new Date\(\)\)\) continue;/);
  assert.match(schedule, /kind: "schedule", title: describeSchedule\(parsed\.data\)/);
});

test("Confirm saves it for the SIGNED-IN person only, timed on the server, capped, audited", () => {
  const action = code("src/app/actions/assistant.ts");
  const run = action.slice(action.indexOf("export async function runAssistantAction"), action.indexOf("export async function askCrmAction"));
  assert.match(run, /const user = await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  const create = run.slice(run.indexOf('case "schedule"'), run.indexOf('case "follow_up"'));
  assert.match(create, /scheduleInput\.safeParse\(/, "the card is re-validated");
  assert.match(create, /const nextRunAt = nextRun\(parsed\.data, new Date\(\)\);/, "nextRunAt is worked out here, not taken from the card");
  assert.match(create, /withScheduleSlot\(user\.id,/);
  assert.match(create, /data: \{ tenantId, userId: user\.id,/);
  assert.doesNotMatch(create, /card\.userId|card\.nextRunAt|card\.tenantId/, "nothing about WHO or WHEN comes from the browser");
  assert.match(create, /logAudit\(\{ action: "assistant\.schedule_created"/);
  const audit = create.slice(create.indexOf("logAudit"), create.indexOf("});", create.indexOf("logAudit")));
  assert.doesNotMatch(audit, /parsed\.data\.question|card\.question/, "the trail carries the timing, not the question");
  // The cap is checked under a per-person lock, inside the write's transaction.
  const runner = code("src/lib/assistantScheduleRun.ts");
  const slot = runner.slice(runner.indexOf("export async function withScheduleSlot"), runner.indexOf("export async function runDueAssistantSchedules"));
  assert.match(slot, /pg_advisory_xact_lock\(hashtext\(\$\{`assistant-schedules:\$\{userId\}`\}\)::bigint\)/);
  assert.match(slot, /tx\.assistantSchedule\.count\(\{ where: \{ userId, active: true \} \}\)\) >= MAX_ACTIVE_SCHEDULES\) return null;/);
});

test("the runner works in ONE real workspace, named on every read and write", () => {
  const runner = code("src/lib/assistantScheduleRun.ts");
  const loop = runner.slice(runner.indexOf("export async function runDueAssistantSchedules"));
  // No scope, a system scope, or a scope without a tenant → nothing runs.
  assert.match(loop, /const scope = currentTenantScope\(\);\s*if \(!scope \|\| scope\.system \|\| !scope\.tenantId\) return \{ ran: 0 \};\s*const tenantId = scope\.tenantId;/);
  assert.ok(loop.indexOf("currentTenantScope()") < loop.indexOf("prisma."), "checked before any query");
  assert.match(loop, /where: \{ tenantId, active: true, nextRunAt: \{ lte: new Date\(\) \} \}/, "due list names the tenant");
  assert.match(loop, /if \(schedule\.tenantId !== tenantId\) continue;/);
  assert.match(loop, /where: \{ id: schedule\.id, tenantId, active: true, nextRunAt: schedule\.nextRunAt \}/, "the claim names the tenant");
  assert.match(loop, /where: \{ id: schedule\.id, tenantId, active: true, nextRunAt: schedule\.nextRunAt \},\s*data: \{ active: false, nextRunAt: null \}/, "so does the switch-off");
  assert.match(loop, /data: \{\s*tenantId,\s*userId: user\.id,/, "the fallback turn is stamped from the scope");
  assert.doesNotMatch(loop, /ownedWriteTenantId|budget\.tenantId/, "the tenant comes from the checked scope only");
  assert.match(loop, /"assistant",\s*\{ tenantId, userId: user\.id \}/, "the push names the tenant and the one person");
});

test("the runner checks the person, THEN claims the run, then runs it as them", () => {
  const runner = code("src/lib/assistantScheduleRun.ts");
  const loop = runner.slice(runner.indexOf("export async function runDueAssistantSchedules"));
  assert.match(loop, /nextRunAt: \{ lte: new Date\(\) \} \},\s*orderBy: \{ nextRunAt: "asc" \}/, "due, oldest first");
  const budgetAt = loop.indexOf("budget.shouldStop(SCHEDULE_RUN_RESERVE_MS)");
  const userAt = loop.indexOf("await assistantUserFor(schedule.userId)");
  const claimAt = loop.indexOf("const claim = await prisma.assistantSchedule.updateMany(");
  const countAt = loop.indexOf("if (claim.count !== 1) continue;");
  const askAt = loop.indexOf("askCrm(user, schedule.question, null, { source: \"schedule\", scheduleId: schedule.id })");
  assert.ok(budgetAt > 0 && budgetAt < userAt, "only started with time to finish");
  assert.ok(userAt > 0 && userAt < claimAt && claimAt < countAt && countAt < askAt, "check the person → claim → check claimed → run");
  // The claim moves it to the next time after NOW (no backfill); a one-off switches off.
  assert.match(loop, /const next = nextRun\(schedule, now\);/);
  assert.match(loop, /data: \{ nextRunAt: next, lastRunAt: now, \.\.\.\(next \? \{\} : \{ active: false \}\) \}/);
  // Someone who can no longer use the assistant: switched off, nothing runs.
  assert.match(loop, /if \(!user \|\| user\.id !== schedule\.userId\) \{\s*const off = await prisma\.assistantSchedule\.updateMany\(\{[\s\S]*?data: \{ active: false, nextRunAt: null \},\s*\}\);\s*if \(off\.count\) \{\s*await logAudit\(\{\s*action: "assistant\.schedule_switched_off",[\s\S]*?\}\);\s*\}\s*continue;/);
  // A failed, skipped or unsaved run still leaves them a note in their thread.
  assert.match(loop, /const briefing = result\.ok && result\.saved;/);
  assert.match(loop, /const note = result\.ok \? SCHEDULE_UNSAVED_NOTE : allowed \? scheduleFailureNote\(result\.error\) : SCHEDULE_SKIPPED_NOTE;/);
  assert.match(loop, /source: "schedule", scheduleId: schedule\.id/);
  // The push goes to them alone, and carries no answer.
  const push = loop.slice(loop.indexOf("sendPushToAll("));
  assert.match(push, /"assistant",\s*\{ tenantId, userId: user\.id \}/);
  assert.doesNotMatch(push.slice(0, push.indexOf('"assistant"')), /result\.answer|schedule\.question/);
  // The reserve fits askCrm's worst case: three 45 s research rounds and a 60 s answer.
  assert.match(runner, /export const SCHEDULE_RUN_RESERVE_MS = 200_000;/);
  assert.match(readFileSync(new URL("../src/lib/assistantScheduleRun.ts", import.meta.url), "utf8"), /ponytail:/, "the throughput ceiling is written down");
});

test("a schedule counts against the person's hourly ask limit, and one person can't take a whole tick", () => {
  const runner = code("src/lib/assistantScheduleRun.ts");
  const loop = runner.slice(runner.indexOf("export async function runDueAssistantSchedules"));
  // The shared limit, checked after the person is re-checked and before anything is asked.
  const userAt = loop.indexOf("await assistantUserFor(schedule.userId)");
  const limitAt = loop.indexOf("const allowed = await assistantAskAllowed(user.id);");
  const askAt = loop.indexOf("await askCrm(user, schedule.question");
  assert.ok(userAt > 0 && userAt < limitAt && limitAt < askAt);
  assert.match(loop, /const result: AssistantResult = !allowed\s*\? \{ ok: false, error: "rate-limited" \}\s*: await askCrm\(/, "over the limit, nothing is asked");
  // At most MAX_RUNS_PER_PERSON_PER_TICK each; the rest are left UNCLAIMED, so still due.
  assert.match(runner, /export const MAX_RUNS_PER_PERSON_PER_TICK = 3;/);
  const capAt = loop.indexOf("if (theirs >= MAX_RUNS_PER_PERSON_PER_TICK) continue;");
  const claimAt = loop.indexOf("const claim = await");
  assert.ok(capAt > 0 && capAt < claimAt, "checked before the claim");
  assert.match(loop, /if \(claim\.count !== 1\) continue;\s*perPerson\.set\(schedule\.userId, theirs \+ 1\);/, "only a claimed run counts");
  assert.doesNotMatch(SCHEDULE_SKIPPED_NOTE, /run again at its next time/, "a one-off has no next time");
  assert.match(SCHEDULE_SKIPPED_NOTE, /too many questions to me in the last hour/);
});

test("a push can be narrowed to one person's devices, never widened", () => {
  const push = code("src/lib/push.ts");
  const send = push.slice(push.indexOf("export async function sendPushToAll("));
  assert.match(send, /userId\?: string \| null/);
  assert.match(send, /const subs = \(options\.endpoint \? recipients\.filter\([\s\S]*?\) : recipients\)\s*\.filter\(\(sub\) => options\.userId == null \|\| sub\.userId === options\.userId\);/);
  assert.ok(push.includes('{ id: "assistant",'), "its own toggle in Settings → Notifications");
});

test("no question or answer text reaches the log", () => {
  for (const file of ["src/lib/assistantScheduleRun.ts", "src/app/api/cron/assistant/route.ts"]) {
    const src = code(file);
    const calls = src.match(/logError\([^;]*;/g) ?? [];
    assert.ok(calls.length > 0, file);
    for (const call of calls) {
      assert.match(call, /^logError\("assistant-schedule", "[^"]+"(, error instanceof Error \? error\.name : "unknown")?/, call);
      assert.doesNotMatch(call, /question|answer|result\.error/, call);
    }
  }
});

test("pause, resume and delete act only on the caller's own schedule, behind the assistant gate", () => {
  const actions = code("src/app/actions/assistantSchedules.ts");
  assert.match(actions, /^"use server";/);
  assert.doesNotMatch(actions, /export (const|function|class|type|let)\b/, "a server-action file exports only async functions");
  const gate = actions.slice(actions.indexOf("async function gate"), actions.indexOf("async function ownSchedule"));
  assert.match(gate, /await requireAnyPermission\(\.\.\.ASSISTANT_PERMISSIONS\);\s*if \(!\(await isModuleEnabled\("automation"\)\)\)/);
  for (const name of ["setAssistantScheduleActive", "deleteAssistantSchedule"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body.slice(0, 300), /const user = await gate\(\);\s*const schedule = await ownSchedule\(id, user\.id\);/, name);
  }
  // Every read and write of a schedule is keyed on the caller and the workspace as well as the id.
  const queries = actions.match(/assistantSchedule\.\w+\(\{\s*where: \{[^}]*\}/g) ?? [];
  assert.equal(queries.length, 4);
  for (const q of queries) {
    assert.match(q, /userId/, q);
    assert.match(q, /tenantId/, q);
  }
  assert.match(actions, /where: \{ id: String\(id\), userId, tenantId: ownedWriteTenantId\(\) \}/);
  assert.doesNotMatch(actions, /where: \{ id(: [^,}]+)? \}/, "never by id alone");
  // Resume starts from now (no backfill) and respects the cap.
  assert.match(actions, /const nextRunAt = nextRun\(schedule, new Date\(\)\);/);
  assert.match(actions, /withScheduleSlot\(user\.id,/);
  for (const audit of ["assistant.schedule_resumed", "assistant.schedule_paused", "assistant.schedule_deleted"]) assert.ok(actions.includes(audit), audit);
});

test("the cron is registered on the shared beat and runs per workspace", () => {
  const route = code("src/app/api/cron/assistant/route.ts");
  assert.match(route, /if \(!isAuthorizedCron\(req\)\) return/);
  assert.match(route, /warmUpForCron\("assistant"/);
  assert.match(route, /export const maxDuration = 300;/);
  assert.match(route, /runCronPerTenant\(async \(_tenantId, budget\) => \{\s*if \(budget\.shouldStop\(SCHEDULE_RUN_RESERVE_MS\)\)[^\n]*\n\s*return runDueAssistantSchedules\(budget\);/);
  assert.match(route, /concurrency: 1,/);
  const crons = (JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
  assert.deepEqual(crons.find((c) => c.path === "/api/cron/assistant"), { path: "/api/cron/assistant", schedule: "*/30 * * * *" });
});

test("scheduled answers are labelled, dotted until seen, and seen when opened", () => {
  const lib = code("src/lib/crmAssistant.ts");
  assert.match(lib.slice(lib.indexOf("export async function assistantTurnsToday")).slice(0, 600), /select: \{ question: true, answer: true, source: true \}/);
  assert.match(lib.slice(lib.indexOf("export async function assistantHistory")).slice(0, 600), /source: true/);
  const seen = code("src/lib/assistantScheduleRun.ts");
  assert.match(seen, /export async function markScheduledTurnsSeen\(userId: string\) \{\s*await prisma\.assistantTurn\.updateMany\(\{\s*where: \{ userId, source: "schedule", seenAt: null \},\s*data: \{ seenAt: new Date\(\) \}/, "their own scheduled turns only");
  const open = code("src/app/actions/assistant.ts");
  assert.match(open.slice(open.indexOf("export async function openAssistantBubble")), /markScheduledTurnsSeen\(user\.id\)/);
  const page = code("src/app/(app)/assistant/page.tsx");
  assert.match(page, /markScheduledTurnsSeen\(user\.id\)/);
  assert.match(page, /prisma\.assistantSchedule\.findMany\(\{\s*where: \{ userId: user\.id \}/, "the page lists only your own");
  const layout = code("src/app/(app)/layout.tsx");
  assert.match(layout, /const assistantUnseen = showAssistant\s*\? await prisma\.assistantTurn\.count\(\{ where: \{ userId: user\.id, source: "schedule", seenAt: null \} \}\)/);
  const chat = code("src/components/AssistantChat.tsx");
  assert.match(chat, /turn\.source === "schedule" \? <p[^>]*>⏰ Scheduled<\/p>/);
  const bubble = code("src/components/AssistantBubble.tsx");
  assert.match(bubble, /const \[unread, setUnread\] = useState\(unseen > 0\);/);
  assert.match(bubble.slice(bubble.indexOf("const toggle")), /setUnread\(false\);/);
});

test("no workspace leads every tick: who goes first moves on each :00 and :30", () => {
  assert.match(code("src/app/api/cron/assistant/route.ts"), /rotationWindowMs: 30 \* 60 \* 1000,/);
  // tenantCron's rotation: offset = floor(startedAt / window) % n.
  const WINDOW = 30 * 60 * 1000;
  for (const n of [2, 3, 4]) {
    const leaders = new Set<number>();
    const day = Date.UTC(2026, 9, 5);
    for (let tick = 0; tick < 48; tick++) leaders.add(Math.floor((day + tick * WINDOW + 5_000) / WINDOW) % n);
    assert.equal(leaders.size, n, `every one of ${n} workspaces leads at some tick`);
  }
});

test("a time is snapped to the half hour the cron actually runs — saved, shown and run the same", () => {
  assert.equal(snapToHalfHour("07:00"), "07:00");
  assert.equal(snapToHalfHour("07:10"), "07:00");
  assert.equal(snapToHalfHour("07:15"), "07:30");
  assert.equal(snapToHalfHour("07:44"), "07:30");
  assert.equal(snapToHalfHour("07:45"), "08:00");
  assert.equal(snapToHalfHour("00:10"), "00:00");
  assert.equal(snapToHalfHour("23:50"), "23:30", "never past midnight — a one-off can't move to another day");
  // What is SAVED (Confirm goes through scheduleInput) is the snapped time.
  const saved = scheduleInput.parse({ question: "Which deals went quiet?", cadence: "daily", timeOfDay: "07:10" });
  assert.equal(saved.timeOfDay, "07:00");
  // What the card SHOWS before Confirm is the snapped time.
  assert.equal(describeSchedule({ cadence: "daily", timeOfDay: "07:10" }), "Every day at 07:00");
  const { actions } = splitActions('ok\nACTIONS: [{"type":"schedule","question":"Which deals went quiet?","cadence":"weekly","weekday":1,"timeOfDay":"07:20"}]');
  assert.equal((actions[0] as { timeOfDay: string }).timeOfDay, "07:30", "the proposal itself is snapped");
  // When it RUNS matches: a row saved earlier with 07:10 still runs (and reads) at 07:00.
  const run = nextRun({ cadence: "daily", timeOfDay: "07:10" }, new Date("2026-10-05T03:00:00Z"));
  assert.equal(run?.toISOString(), "2026-10-05T05:00:00.000Z", "07:00 SA = 05:00 UTC");
  // Every run time lands on the cron's beat (*/30).
  for (const t of ["06:59", "07:01", "13:29", "13:31", "22:14"]) {
    const at = nextRun({ cadence: "daily", timeOfDay: t }, new Date("2026-10-05T00:00:00Z"));
    assert.ok(at && at.getUTCMinutes() % 30 === 0 && at.getUTCSeconds() === 0, t);
  }
  assert.match(code("src/lib/assistantActions.ts"), /timeOfDay is always HH:00 or HH:30/, "DAX proposes only those");
  assert.match(code("src/app/api/cron/assistant/route.ts") + readFileSync(new URL("../vercel.json", import.meta.url), "utf8"), /\*\/30 \* \* \* \*/);
});

test("a database blip skips one run — it never switches someone's schedule off", () => {
  const run = code("src/lib/assistantScheduleRun.ts");
  const check = run.slice(run.indexOf("let user: Awaited<ReturnType<typeof assistantUserFor>>;"));
  assert.match(check, /try \{\s*user = await assistantUserFor\(schedule\.userId\);\s*\} catch \(error\) \{[\s\S]*?continue;\s*\}/);
  assert.ok(check.indexOf("continue;") < check.indexOf("active: false"), "the error path never reaches the switch-off");
});

test("a push meant for one person can never widen to the workspace", () => {
  const push = code("src/lib/push.ts");
  assert.match(push, /\.filter\(\(sub\) => options\.userId == null \|\| sub\.userId === options\.userId\);/);
});
