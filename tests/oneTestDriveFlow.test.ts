import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

// Gap audit #19: the pipeline board's "Book test drive" wrote only a calendar
// activity — never a TestDriveBooking — so those drives never appeared under
// Test drives and skipped licence, identity, indemnity and checkout.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const leads = src("src/app/actions/leads.ts");
const board = leads.slice(leads.indexOf("export async function moveLeadToTestDrive("), leads.indexOf("export async function", leads.indexOf("export async function moveLeadToTestDrive(") + 10));

test("both doors book through the one helper", () => {
  // Inside the transaction that holds the staff schedule locks (#710).
  assert.match(src("src/app/actions/testDrives.ts"), /prisma\.\$transaction\(async \(tx\) => \{[\s\S]*?lockStaffSchedules\(tx,[\s\S]*?return createBookedTestDrive\(tx, \{/);
  assert.match(board, /await createBookedTestDrive\(tx, \{/);
  // The bare activity-only booking is gone.
  assert.doesNotMatch(board, /tx\.activity\.create\(/);
});

test("the helper creates a real booking (status booked, reference, linked activity)", () => {
  const lib = src("src/lib/testDriveBooking.ts");
  assert.match(lib, /tx\.testDriveBooking\.create\(\{[\s\S]*?status: "booked",[\s\S]*?activityId,/);
  assert.match(lib, /reference: newTestDriveReference\(\)/);
});

test("a reschedule from the board moves the upcoming booking, not a second one", () => {
  assert.match(board, /status: \{ in: UPCOMING_TEST_DRIVE_STATUSES \}/);
  assert.match(board, /tx\.testDriveBooking\.update\(\{\s*where: \{ id: upcoming\.id \},/);
});

test("a board reschedule re-checks the booking's demo vehicle before moving it", () => {
  const reschedule = board.slice(board.indexOf("if (upcoming) {"), board.indexOf("tx.testDriveBooking.update({"));
  assert.match(reschedule, /demoVehicleUnavailable\(tx, \{\s*tenantId: upcoming\.tenantId \?\? bookingTenantId,\s*demoVehicleId: upcoming\.demoVehicleId,\s*start: when,\s*end: expectedReturnAt,\s*excludeBookingId: upcoming\.id,/);
  assert.match(reschedule, /if \(clash\) refuse\(clash\)/);
  // The refusal reaches the board as a message, not an error page.
  assert.match(board, /if \(lead instanceof ActionRefusal\) return \{ ok: false, error: lead\.message \}/);
  // Both doors ask the same question.
  assert.match(src("src/app/actions/testDrives.ts"), /await demoVehicleUnavailable\(prisma, \{ \.\.\.args, tenantId: await actingTenantId\(\) \}\)/);
});

test("the shared check names the tenant in both reads, whatever client it is handed", () => {
  const lib = src("src/lib/testDriveBooking.ts");
  assert.match(lib, /db\.demoVehicle\.findFirst\(\{\s*where: \{ id: args\.demoVehicleId, tenantId: args\.tenantId,/);
  assert.match(lib, /db\.testDriveBooking\.findFirst\(\{\s*where: \{\s*tenantId: args\.tenantId,/);
});

test("demoVehicleUnavailable: overlap, inactive car, self-exclusion, other workspaces", async () => {
  const { demoVehicleUnavailable } = await import("../src/lib/testDriveBooking");
  const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
  const bookings = [
    { id: "b1", tenantId: "t1", reference: "TD-ONE", start: at(10), end: at(11) },
    { id: "x1", tenantId: "t2", reference: "TD-OTHER", start: at(13), end: at(14) },
  ];
  let active = true;
  const db = {
    demoVehicle: { findFirst: async () => ({ status: active ? "active" : "retired" }) },
    testDriveBooking: {
      findFirst: async ({ where }: { where: { tenantId: string; id?: { not: string }; scheduledStart: { lt: Date }; expectedReturnAt: { gt: Date } } }) =>
        bookings.find(
          (b) => b.tenantId === where.tenantId && b.id !== where.id?.not && b.start < where.scheduledStart.lt && b.end > where.expectedReturnAt.gt,
        ) ?? null,
    },
  } as never;
  const ask = (start: Date, end: Date, excludeBookingId?: string) =>
    demoVehicleUnavailable(db, { tenantId: "t1", demoVehicleId: "car", start, end, excludeBookingId });
  assert.equal(await ask(at(10), at(11), "b2"), "The demo vehicle is already booked on TD-ONE");
  assert.equal(await ask(at(11), at(12), "b2"), null, "back-to-back is fine");
  assert.equal(await ask(at(10), at(11), "b1"), null, "a booking never clashes with itself");
  assert.equal(await ask(at(13), at(14)), null, "another workspace's booking is never read");
  assert.equal(await demoVehicleUnavailable(db, { tenantId: "t1", demoVehicleId: null, start: at(10), end: at(11) }), null);
  active = false;
  assert.equal(await ask(at(14), at(15)), "That demo vehicle is not available");
});

test("a lead with no customer gets one by the shared identity rules — or a clear refusal", () => {
  assert.match(board, /hasPermission\(user, "leads\.link_contact"\)/);
  assert.match(board, /contactId = await linkOrCreateLeadContact\(leadRow, user, null\)/);
  assert.match(board, /Link a customer to this lead first/);
});

test("an old board-only entry is adopted, not duplicated", () => {
  assert.match(board, /const adopt = legacy && !owned \? legacy\.id : null;/);
  assert.match(board, /adoptActivityId: adopt,/);
});

test("moving the lead back cancels the real booking with a reason", () => {
  assert.match(leads, /status: "cancelled", cancellationReason: `Lead moved back to \$\{lead\.stage\.name\}`/);
});
