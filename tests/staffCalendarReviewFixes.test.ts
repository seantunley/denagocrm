import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";

// staffAvailability.ts is server-only and imports the db client and the acting
// workspace; stub those at load (the pattern in auditTenantConsistency.test.ts)
// so the REAL query builder runs against a fake db that records its `where`.
type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (request === "@/lib/db") return { prisma: {}, basePrisma: {} };
  if (request === "@/lib/actingTenant") return { actingTenantId: async () => "t1" };
  return realLoad.call(this, request, parent, isMain);
} as Loader;
const { findStaffAvailabilityConflict, findStaffCommitmentConflict } = createRequire(import.meta.url)(
  "../src/lib/staffAvailability.ts",
) as typeof import("../src/lib/staffAvailability");

// Review of #710 (staff availability). Each test names the finding it pins.
const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const START = new Date("2026-10-06T08:00:00+02:00");
const END = new Date("2026-10-06T09:00:00+02:00");
function captureWhere() {
  const calls: Array<Record<string, unknown>> = [];
  const db = {
    activity: { findMany: async (args: { where: Record<string, unknown> }) => { calls.push(args.where); return []; } },
    testDriveBooking: { findFirst: async () => null },
    user: { findUnique: async () => null },
  };
  return { db, calls };
}

test("1: conflict queries bound BOTH sides of the window, so old rows cannot crowd out an overlap", async () => {
  for (const find of [findStaffAvailabilityConflict, findStaffCommitmentConflict]) {
    const { db, calls } = captureWhere();
    await find({ userId: "u1", tenantId: "t1", start: START, end: END, db });
    const where = calls[0];
    const and = where.AND as Array<Record<string, unknown>>;
    const window = and.find((clause) => "dueDate" in clause)!;
    assert.deepEqual(window.dueDate, { lt: END });
    assert.deepEqual(window.OR, [
      { endDate: { gt: START } },
      { dueDate: { gt: new Date(START.getTime() - 60 * 60 * 1000) } },
    ]);
  }
});

test("9: the schedule is checked in its workspace, legacy unowned rows included", async () => {
  const { db, calls } = captureWhere();
  await findStaffAvailabilityConflict({ userId: "u1", tenantId: "t1", start: START, end: END, db });
  const and = calls[0].AND as Array<Record<string, unknown>>;
  assert.deepEqual(and[0], { OR: [{ tenantId: "t1" }, { tenantId: null }] });
  for (const file of ["src/app/actions/activities.ts", "src/app/actions/leads.ts", "src/lib/bookingSlots.ts"]) {
    const code = src(file);
    assert.doesNotMatch(code, /lockStaffSchedules\(tx, [a-zA-Z]+ \?\? "global"/, `${file}: no "global" lock fallback`);
    assert.match(code, /await staffScheduleTenantId\(/, `${file}: resolves the schedule's workspace`);
  }
});

test("2: the calendar's default end is an hour after the start", () => {
  const ws = src("src/components/CalendarWorkspace.tsx");
  assert.match(ws, /new Date\(new Date\(`\$\{dateKey\}T\$\{time\}:00\+02:00`\)\.getTime\(\) \+ 60 \* 60 \* 1000\)/);
});

test("3: a test-drive booking reports its real outcome", () => {
  const form = src("src/components/ConflictAwareForm.tsx");
  assert.match(form, /unstable_rethrow\(error\);\s*toast\.error\(ACTION_NOT_DELIVERED\)/);
  assert.match(form, /if \(result\?\.redirectTo\) \{\s*router\.push\(result\.redirectTo\);/);
  const drives = src("src/app/actions/testDrives.ts");
  const create = drives.slice(drives.indexOf("export async function createTestDriveBooking("), drives.indexOf("\nexport async function ", drives.indexOf("export async function createTestDriveBooking(") + 10));
  assert.match(create, /return asActionResult\(async \(\) => \{/);
  const code = create.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /redirect\(|throw new Error\(/);
  assert.match(create, /redirectTo: `\/test-drives\/\$\{booking\.id\}`/);
});

test("4: availability blocks stay out of reminders, the task list and the agendas", () => {
  assert.match(src("src/lib/activityReminders.ts"), /availabilityBlock: false,/);
  assert.match(src("src/app/(app)/activities/page.tsx"), /availabilityBlock: false,/);
  assert.match(src("src/app/(app)/page.tsx"), /status: "planned", availabilityBlock: false, dueDate: \{ lt: todayStart \}/);
  assert.equal(src("src/lib/dashboard/data.ts").match(/status: "planned", availabilityBlock: false,/g)?.length, 2);
});

test("5 + 6: drag reports failures as a toast and keeps the block's own start", () => {
  const ws = src("src/components/CalendarWorkspace.tsx");
  const run = ws.slice(ws.indexOf("function runReschedule("), ws.indexOf("function rescheduleSelected("));
  assert.match(run, /try \{[\s\S]*await rescheduleActivity\(recordId, when\)[\s\S]*\} catch \(error\) \{\s*unstable_rethrow\(error\);\s*toast\.error\(/);
  const drop = ws.slice(ws.indexOf("function dropOnDate("), ws.indexOf("function navigateWeek("));
  assert.match(drop, /const when = new Date\(Date\.parse\(event\.dueDate\) \+ days \* 86_400_000\)\.toISOString\(\);/);
  const actions = src("src/app/actions/activities.ts");
  // A bare date keeps the local time; a zoned instant is taken as is; follow-ups convert it first.
  assert.match(actions, /return new Date\(`\$\{when\}T\$\{time\}:00\+02:00`\);/);
  assert.match(actions, /const local = \/\(\?:Z\|\[\+-\]\\d\{2\}:\?\\d\{2\}\)\$\/\.test\(when\) \? johannesburgLocal\(new Date\(when\)\) : when;/);
  // An access refusal comes back as a value, not a throw that takes the page down.
  assert.match(actions, /return asOwnResult\(\(\) => rescheduleActivityBody\(id, when\), \(error\) => \(\{ ok: false, error \}\)\);/);
});

test("7: a calendar conflict on a gated stage shows the conflict, not the reason prompt", () => {
  const leads = src("src/app/actions/leads.ts");
  // Refused inside the booking transaction, which comes back as { ok: false, error } — no gate.
  assert.match(leads, /if \(availabilityConflict\) refuse\(availabilityConflictMessage\(availabilityConflict\)\);/);
  assert.match(leads, /if \(lead instanceof ActionRefusal\) return \{ ok: false, error: lead\.message \};/);
});

test("8: the chatbot's placeholder assignee is not checked against staff leave", () => {
  const slots = src("src/lib/bookingSlots.ts");
  assert.match(slots, /const scheduleTenant = input\.assignedToId \? await staffScheduleTenantId\(stampTenantId\) : null;/);
  assert.match(slots, /if \(scheduleTenant\) \{\s*await lockStaffSchedules\(tx, scheduleTenant, \[assignedToId\]\);/);
});

test("10: one Johannesburg date-key helper", () => {
  assert.doesNotMatch(src("src/components/CalendarView.tsx"), /function johannesburgDateKey/);
  assert.match(src("src/components/CalendarView.tsx"), /import \{ johannesburgDateKey \} from "@\/lib\/activityDay";/);
  assert.match(src("src/app/actions/staffAvailability.ts"), /johannesburgMidnight\(shiftDateKey\(dateKey, 1\)\)/);
});
