import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * A client-side navigation leaves the @modal slot rendering its last content when
 * the new URL doesn't match it, so a link inside the Settings modal (e.g. a
 * product in Product catalogue) opened its page UNDERNEATH the still-open modal.
 * Verified in a browser on 2026-09-30: 1 dialog left open before, 0 after.
 */
const modal = readFileSync("src/components/SettingsModal.tsx", "utf8");

test("the Settings modal closes itself once the URL leaves /settings", () => {
  assert.match(modal, /if \(!pathname\.startsWith\("\/settings"\)\) return null;/);
});

test("the Settings modal never stacks on top of a full Settings page", () => {
  // Integrations → side menu → Products opened the catalogue as a popup over
  // Settings, and closing it stepped back through the page underneath.
  const workspace = readFileSync("src/components/settings-workspace.tsx", "utf8");
  assert.match(workspace, /<div className="space-y-4" data-settings-page>/, "full Settings pages are marked");
  assert.match(modal, /document\.querySelector\("\[data-settings-page\]"\)/);
  assert.match(modal, /if \(overSettings\) return null;/);
  assert.match(modal, /window\.location\.replace\(window\.location\.href\)/, "loads the section as a full page instead");
});

test("no catch-all @modal route: it matches every URL and breaks no-html-link-for-pages", () => {
  // Tried first (Next's documented pattern); it made three deliberate <a> links
  // (OAuth connect, the error page's hard reload to /login) fail lint.
  assert.ok(!existsSync("src/app/(app)/@modal/[...catchAll]/page.tsx"));
  assert.ok(!existsSync("src/app/(app)/@modal/page.tsx"));
  assert.ok(existsSync("src/app/(app)/@modal/(.)settings/page.tsx"), "Settings still opens as a modal");
});
