import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const src = (rel: string) => readFileSync(rel, "utf8");

// The session check and getActiveTenantId asked the database the same membership
// question several times per page view (prod: 219k scans of a 1-row Tenant table).
test("the per-request membership lookup is React's cache, keyed on the user", () => {
  assert.match(
    src("src/lib/tenantContext.ts"),
    /export const resolveActingTenantForRequest = cache\(\(userId: string\) => resolveActingTenant\(userId\)\);/,
  );
});

test("the read-only session paths use it", () => {
  assert.match(src("src/lib/auth.ts"), /const sole = await resolveActingTenantForRequest\(user\.id\);\s*return honoredTenantClaim/);
  assert.match(src("src/lib/tenantScopeEntry.ts"), /const sole = await resolveActingTenantForRequest\(userId\);/);
});

test("login resolves fresh, never from a memo", () => {
  // Login runs as a Server Action (cache is a pass-through there anyway); keep it explicit.
  assert.match(src("src/lib/auth.ts"), /const ctx = await resolveActingTenant\(user\.id\);/);
});
