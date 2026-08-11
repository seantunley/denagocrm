import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
const quickCreateRouteSource = read("src", "app", "api", "quick-create", "route.ts");
const quickCreateDialogSource = read("src", "components", "QuickCreateDialog.tsx");
const quickCreateActionSource = read("src", "app", "actions", "quickCreate.ts");

test("global quick-create metadata and writes remain tenant scoped", () => {
  assert.match(quickCreateRouteSource, /listActingTenantStaff\(\)/);
  assert.doesNotMatch(quickCreateRouteSource, /prisma\.user\.findMany/);
  assert.match(quickCreateDialogSource, /action=\{createQuickLead\}/);
  assert.match(quickCreateDialogSource, /action=\{createQuickContact\}/);
  assert.match(quickCreateDialogSource, /action=\{createQuickVehicle\}/);
  assert.match(quickCreateDialogSource, /scheduleQuickActivity\(formData\)/);
  // Via the shared contract now, not this file's own copy of the membership
  // check. The gateway and the action it delegates to were two answers to one
  // question; they share an implementation so they cannot give different ones.
  assert.match(quickCreateActionSource, /resolveAssignableUser\(formData\.get\(key\), label\)/);
  assert.doesNotMatch(quickCreateActionSource, /\bresolveTenantMemberUser\s*\(/);
  assert.match(quickCreateActionSource, /prisma\.pipelineStage\.findUnique/);
  assert.match(quickCreateActionSource, /prisma\.contact\.findUnique/);
  assert.match(quickCreateActionSource, /prisma\.product\.findUnique/);
});
