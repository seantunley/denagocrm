import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SETTINGS_AREAS, SETTINGS_NAV_GROUPS, settingsByArea, visibleSettingsGroups } from "../src/lib/settings-navigation";

// Settings reorganisation (settings-reorganisation-plan.md, 2026-11-12): split
// first by who a setting is for, then by the job it does.
test("three areas — my account, the workspace, admin — each group in one, with a line on what it holds", () => {
  assert.deepEqual(SETTINGS_AREAS.map((area) => area.key), ["account", "workspace", "admin"]);
  assert.deepEqual(
    SETTINGS_NAV_GROUPS.map((group) => `${group.area}:${group.label}`),
    [
      "account:My account",
      "workspace:Business",
      "workspace:People & access",
      "workspace:Sales",
      "workspace:Records",
      "workspace:Workshop & stock",
      "workspace:Messaging",
      "workspace:Documents & signing",
      "workspace:Automation & AI",
      "admin:System",
    ],
  );
  for (const group of SETTINGS_NAV_GROUPS) assert.ok(group.description.length > 20, `${group.label} says what is in it`);
  // Areas keep their order, and a viewer with nothing in one doesn't see its heading.
  assert.deepEqual(settingsByArea(SETTINGS_NAV_GROUPS).map((entry) => entry.area.key), ["account", "workspace", "admin"]);
  assert.deepEqual(settingsByArea(visibleSettingsGroups({ isOwner: false, permissions: [] })).map((entry) => entry.area.key), ["account", "workspace"]);
});

test("one subject, one shelf: the pieces that belong together sit together", () => {
  const groupOf = (key: string) => SETTINGS_NAV_GROUPS.find((group) => group.items.some((item) => item.key === key))?.label;
  for (const key of ["team", "lead-routing", "portal-access", "sessions"]) assert.equal(groupOf(key), "People & access", key);
  for (const key of ["email", "signature-banners", "helpdesk", "integrations"]) assert.equal(groupOf(key), "Messaging", key);
  for (const key of ["workshop", "workshop-settings", "products", "stock"]) assert.equal(groupOf(key), "Workshop & stock", key);
  for (const key of ["documents", "signing-workflows", "signing-security"]) assert.equal(groupOf(key), "Documents & signing", key);
  for (const key of ["assistant", "automations", "automatic"]) assert.equal(groupOf(key), "Automation & AI", key);
  for (const key of ["modules", "security", "backups", "system", "queues"]) assert.equal(groupOf(key), "System", key);
  // Clearer names; the old words still find them.
  const item = (key: string) => SETTINGS_NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.key === key)!;
  assert.equal(item("account").label, "Profile & sign-in");
  assert.ok(item("account").keywords?.includes("my account"));
  assert.equal(item("team").label, "Team & roles");
  assert.ok(item("team").keywords?.includes("team & access"));
  assert.equal(item("security").label, "Security checks");
  // The group of one ("Workspace" → "Settings overview") is gone: /settings itself is the home.
  assert.ok(!SETTINGS_NAV_GROUPS.flatMap((group) => group.items).some((entry) => entry.key === "overview"));
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

test("the platform owner sees everything; switched-off modules hide for everyone", () => {
  assert.equal(
    keysFor({ isOwner: true, isPlatformOwner: true, permissions: [] }).length,
    SETTINGS_NAV_GROUPS.flatMap((g) => g.items).length,
  );
  const noAutomotive = keysFor({ isOwner: false, permissions: ["workshop.manage"] }, new Set(["commerce"]));
  assert.ok(!noAutomotive.includes("workshop-settings"));
});

test("a workspace's owner sees its own settings, never the platform's", () => {
  // 2026-10-03: Breastfeeding Art's owner could not open Company profile, Trash,
  // Chatbot… because "owner" meant the PLATFORM owner. The platform entries
  // (what a workspace has bought, whole-database backups, the platform security
  // runbook) stay with the platform.
  const keys = keysFor({ isOwner: true, isPlatformOwner: false, permissions: [] });
  for (const key of ["company", "activity-types", "custom-fields", "clock-weather", "signing-workflows", "signing-security", "sessions", "queues", "email", "system"]) {
    assert.ok(keys.includes(key), `${key} is the workspace's own`);
  }
  for (const key of ["modules", "backups", "security"]) {
    assert.ok(!keys.includes(key), `${key} is platform-only`);
  }
  const platform = SETTINGS_NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.platform).map((i) => i.key).sort();
  assert.deepEqual(platform, ["backups", "modules", "security"]);
});

test("every settings surface asks the one rule", () => {
  const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
  assert.match(read("src/components/settings-workspace.tsx"), /visibleSettingsGroups\(seen\.viewer, seen\.enabled, groups\)/);
  assert.match(read("src/components/AppShell.tsx"), /<SettingsViewerProvider isOwner=\{ownsWorkspace\(user\)\} isPlatformOwner=\{user\.role === "owner"\} permissions=\{user\.permissions\}/);
  assert.match(read("src/components/SidebarHelpSettings.tsx"), /visibleSettingsGroups\(\s*\{ isOwner, isPlatformOwner: seen\?\.viewer\.isPlatformOwner, permissions \}/);
  assert.match(read("src/components/CommandMenu.tsx"), /visibleSettingsGroups\(\{ isOwner: isAdmin, isPlatformOwner, permissions \}, enabledSet\)/);
  assert.match(read("src/lib/search-destinations.ts"), /visibleSettingsGroups\(\{ isOwner: isAdmin, isPlatformOwner, permissions \}\)/);
  assert.match(read("src/app/(app)/settings/page.tsx"), /visibleSettingsGroups\(\s*\{ isOwner: isAdmin, isPlatformOwner: currentUser\.role === "owner", permissions: await getUserPermissionList\(currentUser\) \}/);
});
