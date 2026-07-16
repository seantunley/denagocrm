import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Inventories every API route and asserts each non-public one authenticates
// through an approved guard — so a new protected route can't silently ship
// relying only on the edge proxy (which does NOT do the fresh device/disabled/
// session-version checks that getCurrentUser / requireApiUser do).

const API_DIR = join(process.cwd(), "src", "app", "api");

// Public by design: pre-authentication, customer-facing, or system-authenticated
// (their own secret/signature). Prefixes are matched against the route path
// relative to src/app/api.
const PUBLIC_PREFIXES = [
  "auth/",          // passkey / login endpoints (run before a session exists)
  "bookings",       // public booking widget
  "service-lookup", // public VIN service lookup
  "intake",         // website form intake (X-Api-Key)
  "webhooks/",      // provider webhooks (signature verified)
  "cron/",          // cron routes (CRON_SECRET)
];

// Any of these in a route's source counts as an approved auth/authorization call.
const APPROVED_GUARDS = [
  "requireApiUser", "requireApiOwner",
  "requireUser", "requireOwner",
  "requireCrm", "requireWorkshop", "requireInbox", "requireOperational", "requireAnyModule",
  "requirePermission", "requireAnyPermission",
  "getCurrentUser",
  "requireQuoteReadAccess", "requireLeadReadAccess", "requireLeadAccess", "requireDocumentAccess",
  "portalCanAccess", "requirePortal", "verifyPortal", "portalSession",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

test("every non-public API route authenticates via an approved guard", () => {
  const routes = walk(API_DIR);
  assert.ok(routes.length > 5, "expected to find API routes");

  // A guard must be INVOKED (name followed by `(`), not merely imported or named
  // in a comment. `\w*` lets a prefix match its variants (requireCrmOrWorkshop,
  // portalCanAccessDocument, …).
  const GUARD_CALL = new RegExp(`\\b(?:${APPROVED_GUARDS.join("|")})\\w*\\s*\\(`);
  // A token route must actually look the token up / validate it — not just
  // mention the word "token".
  const TOKEN_VERIFY = /where:\s*\{\s*token\b|isValid\w*Token|verif\w*Token/i;

  const offenders: string[] = [];
  for (const file of routes) {
    const rel = file.slice(API_DIR.length + 1).replace(/\\/g, "/");
    if (PUBLIC_PREFIXES.some((p) => rel.startsWith(p))) continue;

    const src = readFileSync(file, "utf8");
    const guarded = GUARD_CALL.test(src);
    const tokenAuthed = rel.includes("[token]") && TOKEN_VERIFY.test(src);
    if (!guarded && !tokenAuthed) offenders.push(rel);
  }

  assert.deepEqual(
    offenders,
    [],
    `These API routes call no approved auth guard (add one, or allowlist if truly public):\n  ${offenders.join("\n  ")}`,
  );
});
