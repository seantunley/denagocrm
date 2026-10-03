import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 2026-10-03: Breastfeeding Art's owner could not open Chatbot, Flow builder,
// Trash, Company profile, Activity types… 139 checks said `requireOwner()`, and
// role "owner" is the PLATFORM owner (auth.ts) — which a workspace's provisioned
// owner never is. Workspace surfaces now ask requireTenantOwner() (or
// requireRoute for a ROUTE_RULES prefix); only platform surfaces keep requireOwner.

const ROOT = new URL("..", import.meta.url);
const src = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8").replace(/\r\n/g, "\n");
const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

/** The ONLY places a platform-owner check may remain, and why. */
const PLATFORM_ONLY: Record<string, string> = {
  "src/app/actions/modules.ts": "what a workspace has bought is the platform's decision",
  "src/app/(app)/settings/modules/page.tsx": "same",
  "src/app/actions/backups.ts": "backups are of the whole database",
  "src/app/(app)/settings/backup-recovery/page.tsx": "same",
  "src/app/actions/runbook.ts": "the security runbook checks the platform's own configuration",
  "src/app/(app)/settings/security/page.tsx": "same",
  "src/app/actions/security.ts": "setUserRole: role 'owner' is platform-wide",
  "src/lib/auth.ts": "defines requireOwner",
};

test("requireOwner() remains only on platform surfaces", () => {
  const offenders: string[] = [];
  for (const file of walk(fileURLToPath(new URL("../src", import.meta.url)))) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const rel = file.slice(file.indexOf("src")).replace(/\\/g, "/");
    if (/\brequireOwner\s*\(\s*\)/.test(code(rel)) && !(rel in PLATFORM_ONLY)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "a workspace surface must ask requireTenantOwner()/requireRoute(), not the platform owner");
});

test("granting the platform-wide owner role stays with the platform", () => {
  const security = src("src/app/actions/security.ts");
  const setRole = security.slice(security.indexOf("export async function setUserRole("), security.indexOf("export async function ownerResetUser2fa("));
  assert.match(setRole, /const owner = await requireOwner\(\);/);
});

test("a workspace owner manages only their own team, never a platform owner", () => {
  const security = src("src/app/actions/security.ts");
  assert.match(security, /if \(caller\.role !== "owner"\) \{[\s\S]*?target\?\.role === "owner"\) throw new ActionRefusal\(/);
});

test("the session-policy sign-out is the workspace's people, not the platform's", () => {
  const security = src("src/app/actions/security.ts");
  const policy = security.slice(security.indexOf("export async function saveSessionPolicy("), security.indexOf("async function assertManageableUser("));
  assert.match(policy, /WHERE "id" IN \(SELECT "userId" FROM "TenantMember" WHERE "tenantId" = \$\{tenantId\}\)/);
  assert.doesNotMatch(policy, /UPDATE "User" SET "sessionVersion" = "sessionVersion" \+ 1`;/, "never an unfiltered bump");
});

test("a new workspace's users get the workspace's own copy of the starting role", () => {
  const settings = src("src/app/actions/settings.ts");
  assert.match(settings, /result\.tenantId === DEFAULT_TENANT_ID \? "role_sales_rep" : `role_sales_rep:\$\{result\.tenantId\}`/);
  assert.match(settings, /VALUES \(gen_random_uuid\(\)::text, \$\{created\.id\}, \$\{salesRepRoleId\}, \$\{result\.tenantId\}\)/);
});

test("the shell, nav and menus treat the workspace's owner as owner", () => {
  assert.match(src("src/app/(app)/layout.tsx"), /isTenantOwner: await isTenantOwner\(\)\.catch\(\(\) => false\),/);
  const shell = src("src/components/AppShell.tsx");
  assert.match(shell, /const ownsWorkspace = \(user: ShellUser\) => user\.isTenantOwner \?\? user\.role === "owner";/);
  assert.match(shell, /<CommandMenu isAdmin=\{ownsWorkspace\(user\)\} isPlatformOwner=\{user\.role === "owner"\}/);
  assert.match(src("src/app/(app)/settings/page.tsx"), /const isAdmin = await isTenantOwner\(\);/);
  assert.match(src("src/app/(app)/settings/access/page.tsx"), /const canManageSecurity = await isTenantOwner\(\);/);
});

test("the workspace's own surfaces are tenantOwner routes", () => {
  const access = code("src/lib/routeAccess.ts");
  for (const prefix of ["/chatbot", "/bot-builder", "/products", "/trash", "/repairs"]) {
    assert.match(access, new RegExp(`prefix:\\s*"${prefix}",\\s*tenantOwner:\\s*true`), prefix);
  }
});
