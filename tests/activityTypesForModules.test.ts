import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activityTypeAvailable,
  activityTypesForModules,
  pickableActivityTypes,
  SYSTEM_ACTIVITY_TYPES,
} from "../src/lib/activityTypes";

// Sean 2026-10-02: "Test Drive activity should not be in all tenants" — a
// breastfeeding-art studio was offered test drives.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("without the automotive module a test drive is hidden, not dropped", () => {
  const types = activityTypesForModules(SYSTEM_ACTIVITY_TYPES, new Set(["marketing"]));
  const testDrive = types.find((type) => type.key === "test_drive");
  assert.equal(testDrive?.hidden, true, "kept so old activities still have a label");
  assert.ok(!pickableActivityTypes(types).some((type) => type.key === "test_drive"));
  assert.ok(pickableActivityTypes(types).some((type) => type.key === "meeting"));
  assert.equal(activityTypeAvailable("test_drive", new Set()), false);
  assert.equal(activityTypeAvailable("meeting", new Set()), true);
});

test("with the automotive module nothing changes", () => {
  const types = activityTypesForModules(SYSTEM_ACTIVITY_TYPES, new Set(["automotive"]));
  assert.deepEqual(types, [...SYSTEM_ACTIVITY_TYPES]);
  assert.equal(activityTypeAvailable("test_drive", new Set(["automotive"])), true);
});

test("the app layout, settings list, calendar and lead page follow the module", () => {
  assert.match(src("src/app/(app)/layout.tsx"), /enabledModules \? activityTypesForModules\(storedTypes, enabledModules\) : storedTypes/);
  assert.match(src("src/app/(app)/settings/activity-types/page.tsx"), /activityTypeAvailable\(type\.key, enabledModules\)/);
  const ws = src("src/components/CalendarWorkspace.tsx");
  assert.match(ws, /const testDrivesOn = !findActivityType\(activityTypes, "test_drive"\)\?\.hidden;/);
  assert.match(ws, /event\.type === featuredType && happened\(event\)/);
  assert.match(ws, /label: testDrivesOn \? "Test drives" : "Meetings"/);
  assert.match(src("src/app/(app)/leads/[id]/page.tsx"), /\{automotiveOn && \(\s*<Link\s+href=\{`\/leads\/\$\{lead\.id\}\/indemnity`\}/);
});
