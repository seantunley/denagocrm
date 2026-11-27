import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROUTE_RULES, routeGrants } from "../src/lib/routeAccess";

/**
 * Sean, 2026-11-28: "the primary workspace user should have everything if the modules are turned on." A provisioned
 * workspace owner is a `member` with the CRM administrator role, which lacks some permissions — Fourbuy's owner could
 * not reach cases, the document builder or approvals addressed to "the owner". The database half (every permission,
 * this workspace only, modules respected) runs on a real database in test:workspace-integrations.
 */
const query = readFileSync("src/lib/permissionQuery.ts", "utf8");
const permissions = readFileSync("src/lib/permissions.ts", "utf8");

test("the workspace's owner, and only in the workspace being acted in, holds every permission", () => {
  // Decided in the same read as their roles, against the ACTING workspace's own row — never a claim or another tenant.
  assert.match(query, /SELECT \$\{WORKSPACE_OWNER\} AS key\s*WHERE EXISTS \(SELECT 1 FROM "Tenant" t WHERE t\.id = \$\{tenantId\} AND t\."ownerUserId" = \$\{userId\}\)/);
  assert.match(query, /if \(granted\.has\(WORKSPACE_OWNER\)\) \{[\s\S]*?for \(const key of PERMISSIONS\) granted\.add\(key\);/);
  // The marker itself confers nothing on its own (usablePermissions drops every "__" key).
  assert.match(query, /export const WORKSPACE_OWNER = "__workspace_owner__";/);
  assert.match(query, /filter\(\(key\) => !key\.startsWith\("__"\)\)/);
  // A switched-off module still takes its permissions from everyone, the owner included.
  assert.match(permissions, /export async function hasPermission[\s\S]*?if \(!\(await moduleHolds\(permission\)\)\) return false;/);
});

test("a workspace owner's sign-in opens every permission-gated route, never a platform-owner one", () => {
  const granted = new Set(routeGrants("member", [], { tenantOwner: true }).split(",").filter(Boolean));
  for (const rule of ROUTE_RULES) {
    if ("owner" in rule) assert.ok(!granted.has(rule.prefix), `${rule.prefix} is the platform owner's`);
    else assert.ok(granted.has(rule.prefix), `${rule.prefix} should be open to the workspace's owner`);
  }
  // Without ownership, only what the permissions name.
  const member = new Set(routeGrants("member", ["quotes.view_owned"]).split(",").filter(Boolean));
  assert.ok(member.has("/deals"));
  assert.ok(!member.has("/invoices"));
  assert.ok(ROUTE_RULES.filter((rule) => "tenantOwner" in rule).every((rule) => !member.has(rule.prefix)));
});

test("'the owner' in approvals, My Work, the assistant and scheduled email is the workspace's owner", () => {
  assert.match(permissions, /export async function ownsActingWorkspace\(user: PermissionUser\)[\s\S]*?\.has\(WORKSPACE_OWNER\)/);
  const access = readFileSync("src/lib/signing/access.ts", "utf8");
  assert.match(access, /\.\.\.\(owner \? \{\} : \{ assigneeType: "staff", assigneeUserId: user\.id \}\)/);
  assert.match(access, /canActOnStep\(step, user, owner\)/);
  assert.match(readFileSync("src/app/actions/signhub.ts", "utf8"), /canActOnStep\(step, user, await ownsActingWorkspace\(user\)\)/);
  assert.match(readFileSync("src/lib/myWork/load.ts", "utf8"), /step\.assigneeType === "owner" \? owner :/);
  assert.match(readFileSync("src/lib/assistant/context.ts", "utf8"), /sees: owner \? "everything" : "their own"/);
  assert.match(readFileSync("src/lib/daxBrief.ts", "utf8"), /if \(await ownsActingWorkspace\(user\)\) return null;/);
  assert.match(readFileSync("src/lib/emailDrafts.ts", "utf8"), /row\.userId !== user\.id && !\(await ownsActingWorkspace\(user\)\)/);
});
