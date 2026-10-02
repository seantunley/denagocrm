import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SETTINGS_NAV_GROUPS, visibleSettingsGroups } from "../src/lib/settings-navigation";

test("security settings are grouped together", () => {
  const security = SETTINGS_NAV_GROUPS.find((group) => group.label === "Security & Access");
  assert.deepEqual(security?.items.map((item) => item.key), [
    "team",
    "portal-access",
    "security",
    "sessions",
  ]);
});

test("settings reorganisation keeps every destination unique", () => {
  const keys = SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.key));
  assert.equal(new Set(keys).size, keys.length);
  for (const expected of ["company", "modules", "custom-fields", "integrations", "backups", "system"]) {
    assert.ok(keys.includes(expected), `${expected} is still discoverable`);
  }
});

// Gap audit #27: non-owners with a permission couldn't find the settings page it
// opens, and pages they could open listed owner-only pages that bounced them.
const keysFor = (viewer: Parameters<typeof visibleSettingsGroups>[0], enabled?: Set<string>) =>
  visibleSettingsGroups(viewer, enabled).flatMap((g) => g.items.map((i) => i.key));

test("a non-owner sees exactly the settings their permissions open", () => {
  const keys = keysFor({ isOwner: false, permissions: ["pipelines.manage", "workshop.manage", "roles.view"] });
  // "integrations" is the one Integrations page (batch 6), open to tenant owners.
  assert.deepEqual(keys.sort(), ["account", "integrations", "pipeline", "team", "workshop-settings"].sort());
  assert.deepEqual(keysFor({ isOwner: false, permissions: [] }).sort(), ["account", "integrations"]);
});

test("owners see everything; switched-off modules hide for everyone", () => {
  assert.equal(keysFor({ isOwner: true, permissions: [] }).length, SETTINGS_NAV_GROUPS.flatMap((g) => g.items).length);
  const noAutomotive = keysFor({ isOwner: false, permissions: ["workshop.manage"] }, new Set(["commerce"]));
  assert.ok(!noAutomotive.includes("workshop-settings"));
});

test("every settings surface asks the one rule", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(read("src/components/settings-workspace.tsx"), /visibleSettingsGroups\(seen\.viewer, seen\.enabled, groups\)/);
  assert.match(read("src/components/AppShell.tsx"), /<SettingsViewerProvider isOwner=\{user\.role === "owner"\} permissions=\{user\.permissions\}/);
  assert.match(read("src/components/SidebarHelpSettings.tsx"), /visibleSettingsGroups\(\{ isOwner, permissions \}/);
  assert.match(read("src/components/CommandMenu.tsx"), /visibleSettingsGroups\(\{ isOwner: isAdmin, permissions \}, enabledSet\)/);
  assert.match(read("src/lib/search-destinations.ts"), /visibleSettingsGroups\(\{ isOwner: isAdmin, permissions \}\)/);
  assert.match(read("src/app/(app)/settings/page.tsx"), /visibleSettingsGroups\(\s*\{ isOwner: isAdmin, permissions: await getUserPermissionList\(currentUser\) \}/);
});
