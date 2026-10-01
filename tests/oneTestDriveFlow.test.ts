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
  assert.match(src("src/app/actions/testDrives.ts"), /prisma\.\$transaction\(\(tx\) =>\s*createBookedTestDrive\(tx, \{/);
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
