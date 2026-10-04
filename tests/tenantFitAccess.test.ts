import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Tenant-fit audit 2026-10-03 (docs/tenant-fit-audit-2026-10-03.md), PR A:
// what #754 left — owner checks outside settings, API routes, and code pinned
// to the founding workspace.

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("2.1 portal sign-in searches the PORTAL's workspace, not always Denago's", () => {
  const portal = code("src/app/actions/portal.ts");
  const lookup = portal.slice(portal.indexOf("async function findPortalContactByEmail"), portal.indexOf("async function firstStaffUser"));
  assert.match(lookup, /AND "tenantId" = \$\{loginTenantId\}/);
  assert.doesNotMatch(lookup, /DEFAULT_TENANT_ID/);
  assert.match(portal, /tenantEmailContent\("portal_code", await portalLoginTenantId\(\),/);
  // An unverified address has no portal; only dormant dev keeps the founding one.
  assert.match(portal, /return currentTenantScope\(\)\?\.tenantId \?\? \(tenantEnforcing\(\) \? null : DEFAULT_TENANT_ID\);/);
  assert.match(lookup, /if \(!loginTenantId\) return null;/);
});

test("2.1b portal OTP challenges and limits are per workspace, never the bare email", () => {
  const portal = code("src/app/actions/portal.ts");
  assert.match(portal, /return `t:\$\{await portalLoginTenantId\(\)\}:\$\{email\}`;/);
  // Issue, invalidate, lock and verify all use the namespaced key.
  assert.equal((portal.match(/purpose: "portal",\s*key: otpKey/g) ?? []).length, 3);
  assert.match(portal, /otp:portal:\$\{otpKey\}/);
  assert.doesNotMatch(portal, /key: email\b/);
  assert.doesNotMatch(portal, /rateLimitKey\("portal-otp-[a-z-]+", (email|`\$\{email\})/);
});

test("2.2 every workspace's CRM administrator role keeps its admin permissions", () => {
  assert.match(code("src/app/actions/accessControl.ts"), /roleId === "role_crm_admin" \|\| roleId\.startsWith\("role_crm_admin:"\)/);
});

test("1.x workspace owners: targets, erasure, sessions, marketing nav, mobile nav, exports", () => {
  const targets = code("src/app/(app)/targets/page.tsx");
  assert.match(targets, /const isOwner = await isTenantOwner\(\);/);
  assert.doesNotMatch(targets, /user\.role === "owner"/);
  assert.match(code("src/app/actions/privacy.ts"), /if \(!\(await isTenantOwner\(\)\)\) throw new ActionRefusal\(/);
  const sessions = code("src/app/actions/sessions.ts");
  assert.match(sessions, /if \(!\(await isTenantOwner\(\)\)\) return false;\s*return user\.role === "owner" \|\| targetRole !== "owner";/);
  assert.doesNotMatch(sessions, /user\.role !== "owner" &&/);
  for (const file of ["src/app/(app)/marketing/layout.tsx", "src/app/(app)/referrals/layout.tsx"]) {
    assert.match(code(file), /buildMarketingWorkspaceSections\(await isTenantOwner\(\), permissions\)/, file);
  }
  assert.match(code("src/components/MobileCompanionNav.tsx"), /const isOwner = user\.isTenantOwner \?\? user\.role === "owner";/);
  for (const file of ["src/app/(app)/contacts/[id]/page.tsx", "src/app/(app)/fleets/[id]/page.tsx"]) {
    assert.doesNotMatch(code(file), /user\.role === "owner"/, file);
  }
});

test("API routes that serve a workspace its own data take the workspace owner", () => {
  assert.match(code("src/lib/auth.ts"), /export async function requireApiTenantOwner\(\) \{\s*const user = await requireApiUser\(\);\s*if \(!\(await isTenantOwner\(\)\)\) throw new ApiAuthError\(403\);/);
  for (const file of ["src/app/api/contacts/[id]/export/route.ts", "src/app/api/pdf/quote/[id]/route.tsx", "src/app/api/weather-cities/search/route.ts"]) {
    assert.match(code(file), /requireApiTenantOwner\(\)/, file);
  }
  // Whole-database backups stay with the platform.
  assert.match(code("src/app/api/backup-file/route.ts"), /requireApiOwner\(\)/);
});

test("the platform role toggle is offered only to the platform owner", () => {
  assert.match(src("src/components/OwnerUserControls.tsx"), /\{canChangeRole && \(/);
  assert.match(src("src/app/(app)/settings/page.tsx"), /canChangeRole=\{currentUser\.role === "owner"\}/);
});
