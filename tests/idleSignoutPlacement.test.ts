import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The idle sign-out setting sat on the old Settings "Team" tab after the menu stopped linking to it, so owners
// couldn't find it. It lives on Sessions & devices, which the menu does link to — and says that saving signs people out.
test("auto sign-out is on Sessions & devices, with the sign-out warning", () => {
  const sessions = readFileSync("src/app/(app)/settings/sessions/page.tsx", "utf8");
  assert.match(sessions, /action=\{saveSessionPolicy\}/);
  assert.match(sessions, /Saving signs everyone else in this\s+workspace out/);
  // Expired sign-ins are never marked ended, so the list must drop them by their token lifetime.
  assert.match(sessions, /s\.platform === "pwa" \? PWA_SESSION_HOURS : ABSOLUTE_SESSION_HOURS/);
  const settings = readFileSync("src/app/(app)/settings/page.tsx", "utf8");
  assert.doesNotMatch(settings, /saveSessionPolicy/, "only one place may save the sign-out policy");
  const nav = readFileSync("src/lib/settings-navigation.ts", "utf8");
  assert.match(nav, /href: "\/settings\/sessions", keywords: \[[^\]]*"auto sign-out"/);
});
