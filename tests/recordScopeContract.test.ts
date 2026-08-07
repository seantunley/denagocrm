import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaRecordScopeSpy";

/**
 * The contract the dashboard and the leads board are now built on, tested against
 * the shipped helpers rather than restated.
 *
 * getAccessible*Ids answers with three distinct values:
 *   null  → owner or *.view_all — unrestricted, contribute NO filter
 *   []    → holds neither view key — nothing accessible, filter to `in: []`
 *   [id…] → exactly those rows
 *
 * A caller that collapses the first two — `ids?.length ? … : {}`, `in: ids ?? []`
 * — hands every row in the table to a user with no access at all. Both pages spell
 * the ternary out as `ids ? { id: { in: ids } } : {}` and dashboardRecordScope
 * .test.ts holds them to it; this file holds the other end, that the helper really
 * does distinguish the two and does not have to read the table to say so.
 */

/**
 * permissions.ts is `server-only` and builds a live PrismaClient through ./db, so
 * the unit runner cannot load it as shipped. tsx compiles these tests to CommonJS,
 * so both are swapped by intercepting the module loader and then requiring the
 * real modules through it — the shipped helpers, their real control flow, against
 * a recorder. Every swap is anchored on the REQUESTING file so nothing else in the
 * graph is affected.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;

/** The permission set the fake RBAC layer answers with for this test. */
let held = new Set<string>();

const RBAC_INITIALIZED = "__rbac_initialized__";
const RBAC_UNAVAILABLE = "__rbac_unavailable__";

const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  const from = parent?.filename ?? "";
  if (request === "./db" && (from.endsWith("permissions.ts") || from.endsWith("activityAccess.ts"))) {
    return { basePrisma: spy.basePrisma, prisma: spy.prisma };
  }
  if (request === "./permissionQuery" && from.endsWith("permissions.ts")) {
    return {
      RBAC_INITIALIZED,
      RBAC_UNAVAILABLE,
      getUserPermissions: () => Promise.resolve(held),
      usablePermissions: (set: Set<string>) => set,
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const permissions = require_("../src/lib/permissions.ts") as typeof import("../src/lib/permissions");
const activityAccess = require_("../src/lib/activityAccess.ts") as typeof import("../src/lib/activityAccess");

const USER = { id: "u1", name: "Rep", email: "rep@example.com", role: "member" };
const OWNER = { ...USER, id: "u2", role: "owner" };

/** An initialised RBAC snapshot holding exactly `keys`. */
function grant(...keys: string[]) {
  held = new Set([RBAC_INITIALIZED, ...keys]);
}

const HELPERS = [
  { name: "lead", run: () => permissions.getAccessibleLeadIds(USER), all: "leads.view_all", owned: "leads.view_owned" },
  { name: "contact", run: () => permissions.getAccessibleContactIds(USER), all: "contacts.view_all", owned: "contacts.view_owned" },
  { name: "quote", run: () => permissions.getAccessibleQuoteIds(USER), all: "quotes.view_all", owned: "quotes.view_owned" },
  { name: "vehicle", run: () => permissions.getAccessibleVehicleIds(USER), all: "vehicles.view_all", owned: "vehicles.view_owned" },
  { name: "jobCard", run: () => permissions.getAccessibleJobCardIds(USER), all: "jobcards.view_all", owned: "jobcards.view_owned" },
] as const;

test("no view permission is answered [] — not null, and without reading the table", async () => {
  // THE distinction. `null` means unrestricted; returning it here would make the
  // dashboard drop the filter entirely and show a user with no leads permission
  // every lead in the workspace.
  for (const helper of HELPERS) {
    grant("some.unrelated.key");
    spy.reset();
    const result = await helper.run();
    assert.deepEqual(result, [], `${helper.name}: a user holding no view key must get an empty list`);
    assert.notEqual(result, null, `${helper.name}: [] and null are not interchangeable`);
    assert.equal(
      spy.calls.length,
      0,
      `${helper.name}: the refusal must be decided from permissions, not by querying ${spy.calls.length} time(s)`,
    );
  }
});

test("a *.view_all holder is answered null — unrestricted, no query", async () => {
  for (const helper of HELPERS) {
    grant(helper.all);
    spy.reset();
    assert.equal(await helper.run(), null, `${helper.name}: view_all means no filter`);
    assert.equal(spy.calls.length, 0, `${helper.name}: an unrestricted answer needs no query`);
  }
});

test("an owner is answered null for every scope", async () => {
  // An owner short-circuits ahead of RBAC entirely, so the permission set is
  // empty here on purpose: role alone has to carry the answer. The helpers take
  // the user, not HELPERS' bound USER, so they are driven directly.
  held = new Set();
  spy.reset();
  assert.equal(await permissions.getAccessibleLeadIds(OWNER), null);
  assert.equal(await permissions.getAccessibleContactIds(OWNER), null);
  assert.equal(await permissions.getAccessibleQuoteIds(OWNER), null);
  assert.equal(await permissions.getAccessibleVehicleIds(OWNER), null);
  assert.equal(await permissions.getAccessibleJobCardIds(OWNER), null);
  assert.equal(spy.calls.length, 0, "an owner's scope costs no queries");
});

test("an uninitialised or unavailable RBAC snapshot is answered [] , never null", async () => {
  // Fail closed. If the RBAC tables cannot be read, "unrestricted" is the one
  // answer that must not come back.
  for (const broken of [new Set<string>(), new Set([RBAC_UNAVAILABLE, RBAC_INITIALIZED])]) {
    for (const helper of HELPERS) {
      held = broken;
      spy.reset();
      const result = await helper.run();
      assert.deepEqual(result, [], `${helper.name}: a broken RBAC snapshot must deny, not open`);
      assert.equal(spy.calls.length, 0, `${helper.name}: nothing to query when RBAC is unusable`);
    }
  }
});

test("view_owned resolves the caller's own rows, and the query names the caller", async () => {
  grant("leads.view_owned");
  spy.reset([[{ id: "lead-1" }, { id: "lead-2" }]]);
  const leads = await permissions.getAccessibleLeadIds(USER);
  assert.deepEqual(leads, ["lead-1", "lead-2"], "view_owned returns a list, not null");
  assert.equal(spy.calls.length, 1, "one query decides the owned set");
  const raw = spy.calls[0].args as { sql: string; values: unknown[] };
  assert.match(raw.sql, /FROM "Lead"/, "the owned set comes from the lead table");
  assert.ok(raw.values.includes(USER.id), "…parameterised by the caller, not by nothing");
  // Named individually: `values` still contains the caller's id if any ONE of the
  // three ownership arms is widened, so the arms themselves are the assertion.
  assert.match(raw.sql, /"assignedToId" = \?/, "…owned means assigned to me");
  assert.match(raw.sql, /"createdById" = \?/, "…or created by me");
  assert.match(raw.sql, /"teamId" IN \(/, "…or held by a team I am on or manage");
  assert.match(raw.sql, /deletedAt" IS NULL/, "…and never includes trashed leads");
});

test("activities inherit their scope and refuse without the activities keys", async () => {
  // The agenda is the one dashboard card both tabs share, so it is the one that
  // must not fall back to "everything" when a user holds no activities key.
  grant("leads.view_all", "contacts.view_all");
  spy.reset();
  assert.deepEqual(
    await activityAccess.getAccessibleActivityIds(USER),
    [],
    "no activities.view / activities.manage means no agenda, whatever else is held",
  );
  assert.equal(spy.calls.length, 0, "the refusal is decided from permissions");

  grant("activities.view", "leads.view_all", "contacts.view_all");
  spy.reset([[{ id: "act-1" }]]);
  const scoped = await activityAccess.getAccessibleActivityIds(USER);
  assert.deepEqual(scoped, ["act-1"]);
  const query = spy.calls.find((call) => call.model === "activity");
  assert.ok(query, "the accessible set must be resolved from the activity table");
});

test("the dashboard and the leads board are the callers this contract exists for", () => {
  // A contract with no caller is a comment. Named here so deleting the last use
  // fails this file rather than passing quietly.
  const dashboard = require_("node:fs").readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src/lib/dashboard/data.ts"),
    "utf8",
  ) as string;
  for (const helper of ["getAccessibleLeadIds", "getAccessibleQuoteIds", "getAccessibleJobCardIds", "getAccessibleVehicleIds"]) {
    assert.match(dashboard, new RegExp(`\\b${helper}\\(`), `the dashboard must resolve its scope through ${helper}`);
  }
});
