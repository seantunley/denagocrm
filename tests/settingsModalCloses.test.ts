import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";

/**
 * A client-side navigation leaves a parallel slot showing its last content when
 * the new URL doesn't match it, so a link inside the Settings modal (e.g. a
 * product in Product catalogue) opened its page UNDERNEATH the still-open modal.
 * Verified in a browser on 2026-09-30: 1 dialog left open before, 0 after.
 */
const SLOT = "src/app/(app)/@modal";

test("the @modal slot matches every other URL and renders nothing", () => {
  for (const file of [`${SLOT}/[...catchAll]/page.tsx`, `${SLOT}/page.tsx`]) {
    assert.ok(existsSync(file), `${file} must exist to close the modal on navigation`);
    assert.match(readFileSync(file, "utf8"), /return null;/);
  }
});

test("Settings links still open the modal", () => {
  assert.ok(existsSync(`${SLOT}/(.)settings/page.tsx`));
});
