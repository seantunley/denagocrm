import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const shellSource = read("src", "components", "AppShell.tsx");
const quickCreateRouteSource = read("src", "app", "api", "quick-create", "route.ts");
const quickCreateDialogSource = read("src", "components", "QuickCreateDialog.tsx");
const quickCreateActionSource = read("src", "app", "actions", "quickCreate.ts");

test("mobile navigation exposes permission-aware create shortcuts", () => {
  assert.match(shellSource, /can\("leads\.create"\)[\s\S]+kind: "lead"[\s\S]+label: "New lead"/);
  assert.match(shellSource, /can\("contacts\.create"\)[\s\S]+kind: "contact"[\s\S]+label: "New contact"/);
  assert.match(shellSource, /can\("activities\.manage"\)[\s\S]+kind: "calendar"[\s\S]+label: "Schedule activity"/);
  assert.match(shellSource, /can\("quotes\.create"\)[\s\S]+kind: "quote"[\s\S]+label: "New quote"/);
});

test("long press opens actions while movement and normal release cancel the timer", () => {
  assert.match(shellSource, /const LONG_PRESS_MS = 550/);
  assert.match(shellSource, /LONG_PRESS_MOVE_TOLERANCE = 10/);
  assert.match(shellSource, /onPointerMove: movePress/);
  assert.match(shellSource, /onPointerUp: cancelTimer/);
  assert.match(shellSource, /if \(longPressedRef\.current\)[\s\S]+event\.preventDefault\(\)/);
});

test("mobile quick actions use the global create dialog", () => {
  assert.match(shellSource, /openQuickCreate\(kind\)/);
  assert.match(shellSource, /Hold any marked icon/);
  assert.match(shellSource, /event\.shiftKey && event\.key === "F10"/);
});

test("quick-create metadata and writes remain tenant scoped", () => {
  assert.match(quickCreateRouteSource, /listTenantStaff\(\)/);
  assert.doesNotMatch(quickCreateRouteSource, /prisma\.user\.findMany/);
  assert.match(quickCreateDialogSource, /action=\{createQuickLead\}/);
  assert.match(quickCreateDialogSource, /action=\{createQuickContact\}/);
  assert.match(quickCreateDialogSource, /action=\{createQuickVehicle\}/);
  assert.match(quickCreateDialogSource, /scheduleQuickActivity\(formData\)/);
  assert.match(quickCreateActionSource, /resolveTenantMemberUser\(id\)/);
  assert.match(quickCreateActionSource, /prisma\.pipelineStage\.findUnique/);
  assert.match(quickCreateActionSource, /prisma\.contact\.findUnique/);
  assert.match(quickCreateActionSource, /prisma\.product\.findUnique/);
});
