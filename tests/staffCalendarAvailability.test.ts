import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = (path: string) => readFileSync(path, "utf8");

test("activity schema supports ranged internal availability blocks", () => {
  const schema = src("prisma/schema.prisma");
  assert.match(schema, /endDate\s+DateTime\?/);
  assert.match(schema, /allDay\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /availabilityBlock\s+Boolean\s+@default\(false\)/);
  assert.match(schema, /@@index\(\[assignedToId, dueDate, status\]\)/);
});

test("availability uses half-open interval overlap and serialized staff writes", () => {
  const code = src("src/lib/staffAvailability.ts");
  assert.match(code, /startA < endB && endA > startB/);
  assert.match(code, /pg_advisory_xact_lock/);
  assert.match(code, /staff-schedule:/);
  assert.match(code, /availabilityBlock: true/);
  assert.match(code, /status: "planned"/);
});

test("normal activity scheduling checks availability before the write", () => {
  const code = src("src/app/actions/activities.ts");
  const schedule = code.slice(
    code.indexOf("export async function scheduleActivity"),
    code.indexOf("async function finishActivity"),
  );
  assert.ok(schedule.indexOf("lockStaffSchedules") < schedule.indexOf("tx.activity.create"));
  assert.ok(schedule.indexOf("findStaffAvailabilityConflict") < schedule.indexOf("tx.activity.create"));
  assert.match(schedule, /endDate/);
  assert.match(schedule, /availabilityConflictMessage/);
});

test("availability blocks refuse to cover existing customer commitments", () => {
  const code = src("src/app/actions/staffAvailability.ts");
  assert.match(code, /findStaffCommitmentConflict/);
  assert.match(code, /availabilityBlock: true/);
  assert.doesNotMatch(code, /leadId\s*:/);
  assert.doesNotMatch(code, /contactId\s*:/);
  assert.match(code, /assignedToId: assignedTo\.id/);
  assert.match(code, /note/);
});

test("test drives check primary and accompanying salespeople", () => {
  const code = src("src/app/actions/testDrives.ts");
  assert.match(code, /salespersonId, accompanyingSalespersonId/);
  assert.match(code, /lockStaffSchedules/);
  assert.match(code, /findStaffAvailabilityConflict/);
  assert.match(code, /endDate: expectedReturnAt/);
});

test("pipeline test-drive shortcut cannot bypass staff availability", () => {
  const code = src("src/app/actions/leads.ts");
  const start = code.indexOf("export async function moveLeadToTestDrive");
  const end = code.indexOf("export async function searchLinkableContacts", start);
  const fn = code.slice(start, end);
  assert.match(fn, /lockStaffSchedules/);
  assert.match(fn, /findStaffAvailabilityConflict/);
  assert.match(fn, /endDate: whenEnd/);
});

test("calendar shows staff availability user and note, including multi-day blocks", () => {
  const view = src("src/components/CalendarView.tsx");
  const workspace = src("src/components/CalendarWorkspace.tsx");
  assert.match(view, /availabilityBlock: true/);
  assert.match(view, /endDate: \{ gt: queryBounds\.start \}/);
  assert.match(view, /shiftDateKey/);
  assert.match(workspace, /event\.assignee} · \{event\.summary/);
  assert.match(workspace, /event\.note \|\| "Unavailable"/);
  assert.match(workspace, /Block time/);
  assert.match(workspace, /AvailabilityConflictDialog/);
});

test("availability blocks are workspace-visible but explicitly tenant scoped", () => {
  const code = src("src/lib/activityAccess.ts");
  assert.match(code, /availabilityBlock: true, tenantId/);
});
