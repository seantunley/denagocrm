import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Phase C step 2b — "wiring" guard for the no-user token routes. These handlers
// carry NO staff session, so under enforcement they must establish the request's
// tenant scope from the row they resolve by token; without it the db guard would
// fail closed (or, worse, run unscoped). This test asserts the chokepoint is
// present in each route's SOURCE, so a route added/removed later can't silently
// drop it. It's deliberately structural (reads the files) — the runtime behaviour
// of establishTenantScopeFromId is covered by the guard unit + integration suites.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routeSrc = (rel: string) => readFileSync(path.join(root, rel), "utf8");

// Every no-user token route must derive + establish its tenant from the row.
const TOKEN_ROUTES = [
  "src/app/api/signing/[token]/route.ts",
  "src/app/api/signing/[token]/decline/route.ts",
  "src/app/api/approvals/[token]/route.ts",
  "src/app/api/track/o/[token]/route.ts",
  "src/app/api/track/c/[token]/route.ts",
  "src/app/api/unsubscribe/[token]/route.ts",
];

for (const rel of TOKEN_ROUTES) {
  test(`${rel}: establishes a tenant scope (no-user chokepoint present)`, () => {
    const src = routeSrc(rel);
    assert.match(src, /from "@\/lib\/tenantScopeEntry"/, `${rel} must import from tenantScopeEntry`);
    assert.match(src, /establishTenantScopeFromId\s*\(/, `${rel} must call establishTenantScopeFromId`);
  });
}

// Routes that return a MEANINGFUL response (not a best-effort pixel/redirect) must
// also fail closed under enforcement when the resolved row has no tenant, rather
// than let the guard throw an opaque 500. The tracking routes intentionally do NOT
// gate — they swallow errors and always deliver the pixel/redirect.
const FAIL_CLOSED_ROUTES = [
  "src/app/api/signing/[token]/route.ts",
  "src/app/api/signing/[token]/decline/route.ts",
  "src/app/api/approvals/[token]/route.ts",
];

for (const rel of FAIL_CLOSED_ROUTES) {
  test(`${rel}: fails closed under enforcement when the row carries no tenant`, () => {
    const src = routeSrc(rel);
    assert.match(src, /from "@\/lib\/tenantEnforcement"/, `${rel} must import tenantEnforcing`);
    assert.match(
      src,
      /tenantEnforcing\(\)\s*&&\s*!\w+(?:\.\w+)*\.tenantId/,
      `${rel} must gate on tenantEnforcing() && !<row>.tenantId`,
    );
  });
}
