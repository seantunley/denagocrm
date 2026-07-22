import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_NAV_GROUPS } from "../src/lib/settings-navigation";

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
