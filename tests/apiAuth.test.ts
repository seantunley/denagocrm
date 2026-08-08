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
  "auth/passkey/auth/", // login CEREMONY only (runs before a session exists).
  //                       NOT auth/passkey/register/* — those manage a signed-in
  //                       user's passkeys and must call a guard.
  "bookings",       // public booking widget
  "service-lookup", // public VIN service lookup
  "intake",         // website form intake (X-Api-Key)
  "webhooks/",      // provider webhooks (signature verified)
  "cron/",          // cron routes (CRON_SECRET)
  // Tenant brand logo. PUBLIC BY NECESSITY: its consumer is the LOGIN page, which
  // renders before any session exists — the same reason /login itself is public.
  // It is not a file reader: the caller supplies a tenant id, never a blob ref,
  // and the only object it will stream is whatever a platform admin stored in
  // Tenant.brandLogoRef (content type allow-listed on upload, pinned on
  // response, nosniff). It discloses what that tenant's own login page already
  // shows the world. Suspended tenants 404. See the route's header comment.
  "brand/logo",
  // Domain reachability check. PUBLIC BY NECESSITY, and the necessity is the
  // whole function: we fetch it ourselves, over the internet, at the hostname
  // being verified, to learn whether that hostname reaches this deployment. A
  // guarded route could not answer — there is no session on a domain that has
  // not been set up yet. It reads no database, writes nothing, takes no
  // parameters, and returns the caller's own Host header plus an HMAC of it, so
  // there is nothing behind it to reach.
  "brand/domain-check",
];

// NOTE: this proves an authENTICATION guard is invoked; it does not prove
// record-level authoriZation. A stronger form (route-policy manifest or AST
// inspection) is tracked as a follow-up.

// Any of these in a route's source counts as an approved auth/authorization call.
const APPROVED_GUARDS = [
  "requireApiUser", "requireApiOwner",
  "requireUser", "requireOwner",
  // The module-CSV family (requireCrm/requireWorkshop/requireInbox/
  // requireOperational/requireAnyModule) is gone — it gated on User.modules,
  // a second authorization source RBAC never wrote to.
  "requirePermission", "requireAnyPermission", "requireRoute",
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
