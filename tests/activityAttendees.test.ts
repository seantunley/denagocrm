import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Sean 2026-10-02: a meeting he and Donovan both go to could only name one of
// them — Activity has a single assignee, so it was entered once per person.
// ActivityAttendee holds everyone else at it.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const actions = src("src/app/actions/activities.ts");
const body = (name: string) => actions.slice(actions.indexOf(`async function ${name}(`), actions.indexOf("\n}\n", actions.indexOf(`async function ${name}(`)));

test("the table is tenant-owned and behind a forced policy", () => {
  const sql = src("prisma/migrations/20261002120000_activity_attendees/migration.sql");
  assert.match(sql, /"tenantId" TEXT NOT NULL/);
  assert.match(sql, /ALTER TABLE "ActivityAttendee" ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /CREATE POLICY "ActivityAttendee_tenant_isolation"/);
  assert.match(sql, /ALTER TABLE "ActivityAttendee" FORCE ROW LEVEL SECURITY;/);
  assert.match(sql, /FOREIGN KEY \("activityId"\) REFERENCES "Activity"\("id"\) ON DELETE CASCADE/);
});

test("scheduling checks and locks every person, and stamps the attendee rows", () => {
  const schedule = body("scheduleActivityBody");
  assert.match(schedule, /const attendees = await resolveAttendees\(formData, assignedToId\);/);
  assert.match(schedule, /const people = \[assignedToId, \.\.\.attendees\.map\(\(person\) => person\.id\)\];/);
  assert.match(schedule, /lockStaffSchedules\(tx, scheduleTenant, people\);\s*for \(const userId of people\) \{\s*const conflict = await findStaffAvailabilityConflict/);
  assert.match(schedule, /attendees: \{ create: attendees\.map\(\(person\) => \(\{ userId: person\.id, tenantId: scheduleTenant \}\)\) \}/);
  assert.match(schedule, /if \(workshop && attendees\.length\) refuse\(/);
});

test("moving or editing a meeting checks everyone, and an edit without the picker keeps them", () => {
  const reschedule = body("rescheduleActivityBody");
  assert.match(reschedule, /const people = \[existing\.assignedToId, \.\.\.existing\.attendees\.map\(\(row\) => row\.userId\)\];/);
  assert.match(reschedule, /for \(const userId of people\) \{\s*const conflict = await findStaffAvailabilityConflict/);
  const update = body("updateActivityBody");
  assert.match(update, /formData\.has\("attendeesShown"\)\s*\? \(await resolveAttendees\(formData, assignedToId\)\)/);
  assert.match(update, /: existing\.attendees\.map\(\(row\) => row\.userId\)/);
  assert.match(update, /await tx\.activityAttendee\.deleteMany\(\{ where: \{ activityId: id \} \}\);/);
  assert.match(update, /tenantId: scheduleTenant \}\)\),/);
});

test("an attendee can open, see and work with the meeting", () => {
  assert.match(actions, /activity\.attendees\.some\(\(row\) => row\.userId === user\.id\)/);
  assert.match(src("src/lib/activityAccess.ts"), /\{ attendees: \{ some: \{ userId: user\.id \} \} \},/);
});

test("blocking time sees the meetings a person attends", () => {
  assert.match(src("src/lib/staffAvailability.ts"), /OR: \[\{ assignedToId: args\.userId \}, \{ attendees: \{ some: \{ userId: args\.userId \} \} \}\],/);
});

test("calendar, owner filter and reminder name everyone", () => {
  const view = src("src/components/CalendarView.tsx");
  assert.match(view, /assignee: activityPeople\(activity\)\.join\(", "\),\s*people: activityPeople\(activity\),/);
  const ws = src("src/components/CalendarWorkspace.tsx");
  assert.match(ws, /\(!owner \|\| event\.people\.includes\(owner\)\)/);
  assert.match(ws, /events\.flatMap\(\(event\) => event\.people\)/);
  assert.match(src("src/lib/activityReminders.ts"), /activityPeople\(a\)\.join\(", "\)/);
});

test("the forms offer the picker; the edit form only when attendees were loaded", () => {
  const panel = src("src/components/ActivityPanel.tsx");
  assert.match(panel, /<AttendeePicker users=\{users\} className="col-span-2 md:col-span-4" \/>/);
  assert.match(panel, /\{a\.attendees && \(\s*<AttendeePicker/);
  assert.match(src("src/components/QuickCreateDialog.tsx"), /<AttendeePicker users=\{currentOptions\.users\} \/>/);
  const picker = src("src/components/AttendeePicker.tsx");
  assert.match(picker, /name="attendeesShown"/);
  assert.match(picker, /name="attendeeIds"/);
});
