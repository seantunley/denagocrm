import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/(app)/test-drives/page.tsx", "utf8");
const trigger = readFileSync("src/components/test-drives/TestDriveBookingTrigger.tsx", "utf8");
const mobileNav = readFileSync("src/components/MobileCompanionNav.tsx", "utf8");

test("mobile test drives exposes the real booking workflow as its primary action", () => {
  const mobileStart = page.indexOf('<MobileOnly className="space-y-4">');
  const desktopStart = page.indexOf('<DesktopOnly className="space-y-6">');
  const mobileView = page.slice(mobileStart, desktopStart);

  assert.match(mobileView, /<MobileWorkspaceHeader[\s\S]*action={canCreate \? \([\s\S]*<TestDriveBookingTrigger/);
  assert.match(mobileView, /compact/);
  assert.match(trigger, /form action={createTestDriveBooking}/, "the mobile action must create rather than only list bookings");
  assert.match(trigger, /Create booking/);
});

test("mobile and desktop use the same complete test-drive filters", () => {
  assert.match(
    page,
    /const TEST_DRIVE_FILTERS = \["", "booked", "confirmed", "checked_out", "completed", "cancelled", "no_show"\] as const/,
  );
  assert.equal((page.match(/TEST_DRIVE_FILTERS\.map/g) ?? []).length, 2);
  assert.match(page, /\{ label: "Fleet", href: "\/test-drives\/demo-fleet" \}/);
});

test("the Capture sheet describes the test-drive destination accurately", () => {
  assert.match(mobileNav, /Start a booking or check current drives/);
});
