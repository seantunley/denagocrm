import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, test } from "node:test";
import Module, { createRequire } from "node:module";

/*
 * A member's roles are looked up in a workspace. In a Server Action that is not
 * wrapped in withActingStaffScope there is no workspace bound, and the lookup
 * used to run in none: no roles, so requirePermission redirected a sales rep
 * home for holding exactly the permission the action asked for (found
 * 2026-10-12: opening the email composer). The lookup now re-derives the
 * session's own workspace at its point of use, as the scoped Prisma client and
 * the record-access checks already do.
 *
 * The end-to-end proof is a production build under enforcement with a member's
 * session (the composer walk-through); isolated Node cannot reproduce the lost
 * scope. These pin the rule the lookup follows and how it is wired.
 */

const state = {
  enforcing: true,
  bound: null as { tenantId: string | null } | null,
  /** The workspace each role lookup was made in. */
  askedIn: [] as (string | null)[],
};

type Loader = (request: string, parent: { filename?: string } | undefined, isMain: boolean) => unknown;
const loader = Module as unknown as { _load: Loader };
const realLoad = loader._load;
loader._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only") return {};
  if ((parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/permissionQuery.ts")) {
    switch (request) {
      case "./db": return {
        basePrisma: {
          // Tagged template: the values are (userId, tenantId, marker) when enforcing, (userId, marker) otherwise.
          $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const tenantId = values.length === 3 ? (values[1] as string | null) : "ANY";
            state.askedIn.push(tenantId);
            const rows = [{ key: "__rbac_initialized__" }];
            if (tenantId === "t1" || tenantId === "ANY") rows.push({ key: "leads.edit" });
            return rows;
          },
        },
      };
      case "./tenantEnforcement": return { tenantEnforcing: () => state.enforcing };
      case "./tenantScope": return { currentTenantScope: () => state.bound };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const { getUserPermissions, workspaceForRoleLookup } = require_("../src/lib/permissionQuery.ts") as typeof import("../src/lib/permissionQuery");

beforeEach(() => {
  state.enforcing = true;
  state.bound = null;
  state.askedIn = [];
});

test("NO WORKSPACE BOUND (an unwrapped Server Action): the roles are read in the session's own workspace", async () => {
  let recoveries = 0;
  const session = async () => { recoveries += 1; return { tenantId: "t1" }; };
  assert.equal(await workspaceForRoleLookup(null, session), "t1");
  assert.equal(await workspaceForRoleLookup(undefined, session), "t1");
  assert.equal(recoveries, 2);
});

test("a bound workspace always wins, and the session is never consulted", async () => {
  const never = async () => { throw new Error("the session must not be read when a scope is bound"); };
  assert.equal(await workspaceForRoleLookup({ tenantId: "t2" }, never), "t2");
  // A bound scope with NO workspace (the global owner's) is still a bound scope: not replaced by the session's.
  assert.equal(await workspaceForRoleLookup({ tenantId: null }, never), null);
  assert.equal(await workspaceForRoleLookup({}, never), null);
});

test("no workspace and no session (WhatsApp door, cron, sign-in): nothing is invented", async () => {
  assert.equal(await workspaceForRoleLookup(null, async () => null), null);
  assert.equal(await workspaceForRoleLookup(null, async () => ({ tenantId: null })), null);
});

test("the lookup asks in the bound workspace, and only that one grants", async () => {
  state.bound = { tenantId: "t1" };
  assert.ok((await getUserPermissions("u1")).has("leads.edit"));
  state.bound = { tenantId: "t2" };
  assert.equal((await getUserPermissions("u1")).has("leads.edit"), false);
  assert.deepEqual(state.askedIn, ["t1", "t2"]);
});

test("enforcement off: the query is what it always was, and no workspace is worked out at all", async () => {
  state.enforcing = false;
  await getUserPermissions("u1");
  assert.deepEqual(state.askedIn, ["ANY"]);
  const src = readFileSync("src/lib/permissionQuery.ts", "utf8");
  assert.match(src, /const tenantId = enforcing \? await actingWorkspaceId\(\) : null;/);
});

test("the recovery is the shared, fully revalidating one — not a second way to read a cookie", () => {
  const src = readFileSync("src/lib/permissionQuery.ts", "utf8");
  assert.match(src, /workspaceForRoleLookup\(currentTenantScope\(\), async \(\) => \{/);
  assert.match(src, /const \{ recoverStaffScopeFromSession \} = await import\("\.\/scopeRecovery"\);\s*return recoverStaffScopeFromSession\(\);/);
  assert.doesNotMatch(src, /cookies\(\)|verifySession/);
  // The query takes the workspace it was given; it no longer reads the ambient scope itself.
  assert.match(src, /ur\."tenantId" IS NOT DISTINCT FROM \$\{tenantId\}/);
  assert.equal((src.match(/currentTenantScope\(\)/g) ?? []).length, 1);
});
