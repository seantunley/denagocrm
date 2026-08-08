import assert from "node:assert/strict";
import { test } from "node:test";
import Module, { createRequire } from "node:module";

import { ruleFor } from "../src/lib/routeAccess";
import { NO_FLEET_PICKER } from "../src/lib/fleetTypes";
// Statically imported, not `await import`ed: tsx compiles this file to CommonJS,
// which has no top-level await. None of these three needs the loader swap below —
// they are pure and pull in neither `server-only` nor a Prisma client.
import { withTenant } from "../src/lib/tenantScope";
import { __setTenantEnforcingForTests } from "../src/lib/tenantEnforcement";
import { TenantScopeError } from "../src/lib/tenantGuard";

/**
 * BEHAVIOURAL permission + tenant tests for the contact form's fleet dropdown.
 *
 * `/fleets` is guarded `anyOf: ["fleets.view", "fleets.manage"]`. The new "Fleet"
 * option on the customer-type selector renders a dropdown listing every fleet
 * ACCOUNT BY NAME — which is that guarded page's data reached through a different
 * door, on a form guarded by `contacts.*`. The names of an operator's customer
 * accounts are exactly what the fleets permission exists to withhold.
 *
 * Two things have to be true and neither can be read off the source:
 *   1. Without the permission, NO QUERY RUNS. "Fetch it and hide it" is still a
 *      read, and still puts the names in the RSC payload.
 *   2. With it, the query names the tenant. The db.ts guard rewrites nothing
 *      while enforcement is off — production's state — so an unscoped picker
 *      lists every workspace's fleets.
 *
 * `fleetDirectory.ts` is `server-only` and imports a live PrismaClient, so the
 * unit runner cannot load it as shipped: the `server-only` marker package is not
 * installed (Next vendors it and swaps it in through an RSC export condition),
 * and `./db` builds a real client against DATABASE_URL. tsx compiles these tests
 * to CommonJS, so both are swapped by intercepting the module loader and then
 * requiring the REAL module through it — the shipped function, its real query,
 * run against an in-memory table. Each swap is anchored on the REQUESTING file,
 * so it cannot accidentally hand a fake to some other module.
 */

type FleetRow = { id: string; name: string; tenantId: string };

const MINE = "tenant_mine";
const THEIRS = "tenant_theirs";

const FLEETS: FleetRow[] = [
  { id: "flt_1", name: "Sunset Lodge", tenantId: MINE },
  { id: "flt_2", name: "Fairway Estate", tenantId: MINE },
  { id: "flt_3", name: "RIVAL RESORT", tenantId: THEIRS },
];

/** Mutable fixture state, reset per test. */
const state = {
  /** Permissions the signed-in user holds. */
  granted: new Set<string>(),
  /** Every `where` the picker queried with. Empty means no query ran. */
  queries: [] as Record<string, unknown>[],
  /** Every permission key set the picker asked about. */
  asked: [] as string[][],
};

function reset(granted: string[]) {
  state.granted = new Set(granted);
  state.queries = [];
  state.asked = [];
}

const fakePrisma = {
  fleet: {
    findMany(args: { where?: Record<string, unknown>; take?: number }) {
      state.queries.push(args.where ?? {});
      // Filters on exactly what it is asked for and nothing more — a stub that
      // scoped by tenant itself would pass whether or not the code under test
      // named the tenant.
      const where = args.where ?? {};
      const rows = FLEETS.filter((fleet) =>
        Object.entries(where).every(([field, value]) => (fleet as never)[field] === value),
      );
      return Promise.resolve(rows.map(({ id, name }) => ({ id, name })));
    },
  },
};

const fakeAuth = { requireUser: async () => ({ id: "u1", role: "staff", name: "Staff" }) };

const fakePermissions = {
  hasAnyPermission: async (_user: unknown, ...keys: string[]) => {
    state.asked.push(keys);
    return keys.some((key) => state.granted.has(key));
  },
};

type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (parent?.filename?.endsWith("fleetDirectory.ts")) {
    // The module NAMESPACE, not the client — fleetDirectory does
    // `import { prisma } from "./db"`.
    if (request === "./db") return { prisma: fakePrisma };
    if (request === "./auth") return fakeAuth;
    if (request === "./permissions") return fakePermissions;
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const directory = createRequire(import.meta.url)(
  "../src/lib/fleetDirectory.ts",
) as typeof import("../src/lib/fleetDirectory");

/** The permissions ROUTE_RULES actually grants `/fleets`, read from the table. */
const fleetsRule = ruleFor("/fleets");
const FLEET_GRANTS = fleetsRule && "anyOf" in fleetsRule ? [...fleetsRule.anyOf] : [];

// ── the constrained user ────────────────────────────────────────────────────

test("a user without either fleet permission is offered nothing AND reads nothing", async () => {
  // THE ASSERTION THAT MATTERS: `queries` is empty. Returning an empty list after
  // querying would still have put every fleet name in the response payload.
  reset(["contacts.view_all", "contacts.create", "contacts.edit"]);

  const picker = await withTenant(MINE, () => directory.fleetPicker());

  assert.deepEqual(picker, NO_FLEET_PICKER);
  assert.equal(picker.canLink, false, "…and the form must say why, not show an empty dropdown");
  assert.deepEqual(state.queries, [], "no fleet may be read by someone who may not see fleets");
});

test("a signed-in user with NO permissions at all is refused", async () => {
  reset([]);
  const picker = await withTenant(MINE, () => directory.fleetPicker());
  assert.deepEqual(picker, NO_FLEET_PICKER);
  assert.deepEqual(state.queries, []);
});

test("either fleet permission opens the picker, and only those two", async () => {
  for (const grant of FLEET_GRANTS) {
    reset([grant]);
    const picker = await withTenant(MINE, () => directory.fleetPicker());
    assert.equal(picker.canLink, true, `${grant} must be enough to link a contact to a fleet`);
    assert.equal(state.queries.length, 1);
  }
  assert.deepEqual(
    FLEET_GRANTS,
    ["fleets.view", "fleets.manage"],
    "the /fleets rule changed — the picker's gate must change with it",
  );
});

test("the picker gates on exactly the permissions ROUTE_RULES gives /fleets", async () => {
  // Restating the list is how the dropdown and the page drift apart, and the
  // drift is invisible: the page bounces you, the dropdown still names every
  // account. This reads the rule from the table and compares.
  reset(["fleets.view"]);
  await withTenant(MINE, () => directory.fleetPicker());

  assert.equal(state.asked.length, 1, "the picker must ask exactly once");
  assert.deepEqual(
    [...state.asked[0]].sort(),
    [...FLEET_GRANTS].sort(),
    "the picker's permission set must equal the /fleets route rule",
  );
});

// ── tenant safety ───────────────────────────────────────────────────────────

test("the picker lists this workspace's fleets and no other's", async () => {
  reset(["fleets.view"]);
  const picker = await withTenant(MINE, () => directory.fleetPicker());

  assert.deepEqual(
    picker.fleets.map((fleet) => fleet.name),
    ["Sunset Lodge", "Fairway Estate"],
    "another workspace's fleet account was offered on the contact form",
  );
  assert.equal(state.queries[0].tenantId, MINE, "the query must name the tenant, not rely on db.ts");
});

test("a different workspace sees a different list through the same code", async () => {
  reset(["fleets.manage"]);
  const picker = await withTenant(THEIRS, () => directory.fleetPicker());
  assert.deepEqual(picker.fleets.map((fleet) => fleet.name), ["RIVAL RESORT"]);
});

test("under enforcement, a scopeless picker refuses rather than listing every tenant", async () => {
  reset(["fleets.view"]);
  try {
    __setTenantEnforcingForTests(true);
    await assert.rejects(() => directory.fleetPicker(), TenantScopeError);
    assert.deepEqual(state.queries, [], "nothing may be read before the scope is checked");
  } finally {
    __setTenantEnforcingForTests(null);
  }
});
