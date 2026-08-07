import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import * as spy from "./stubs/prismaRecordAccessSpy";

/**
 * "Unrestricted within my tenant" is never "unrestricted".
 *
 * Every `canAccess*` helper in `lib/permissions.ts` answered from an
 * accessible-id list, and those lists return `null` to mean "no restriction
 * applies to you". `ids === null || ids.includes(id)` turns that sentence into
 * "true for ANY id at all" — an id in another tenant, or an id that does not
 * exist anywhere. `documents.view_all` is a statement about how much of MY
 * workspace I may see; it is not a statement about whose workspace it is.
 *
 * `canAccessDocument` was fixed for exactly this, after `deleteDocument` was
 * found writing through the trash helper on `basePrisma` — RLS-free — so a
 * `documents.manage` holder could soft-delete another tenant's document by id.
 * The six siblings had the identical shape and never got the same treatment,
 * which left every call site that looks guarded — signing, doc studio, case
 * attachments, job-card photos, communications, test drives — resting on it.
 *
 * These are BEHAVIOURAL: the shipped helpers, their real queries, run against a
 * two-tenant fixture. The last test in the file is the structural guard that
 * stops a seventh helper being added without the same shape.
 */

/**
 * `permissions.ts` reaches the whole server stack — `./db` builds a live
 * PrismaClient against DATABASE_URL, `./auth` and `./modules/enabled` are
 * `server-only`, and `server-only` itself is not installed (Next vendors it and
 * swaps it in through an RSC export condition). tsx compiles these tests to
 * CommonJS, so all of that is swapped by intercepting the module loader and then
 * requiring the REAL module through it.
 *
 * Each swap is anchored on the REQUESTING file, so the fake database cannot leak
 * into some other module that happens to import `./db`.
 *
 * `./tenantPredicate` is deliberately NOT stubbed. It is the thing under test.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const fromPermissions = (parent: { filename?: string } | undefined) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith("src/lib/permissions.ts");

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  if (fromPermissions(parent)) {
    if (request === "./db") return { basePrisma: spy.basePrisma, prisma: spy.basePrisma };
    if (request === "./permissionQuery") return spy.permissionQuery;
    if (request === "./auth") {
      return { requireUser: () => Promise.reject(new Error("requireUser is not part of this test")) };
    }
    if (request === "./modules/enabled") return { requireModuleEnabled: () => Promise.resolve() };
    if (request === "next/navigation") {
      return { redirect: () => { throw new Error("redirect"); } };
    }
  }
  return realLoad.call(this, request, parent, isMain);
} as Loader;

const require_ = createRequire(import.meta.url);
const permissions = require_("../src/lib/permissions.ts") as typeof import("../src/lib/permissions");
const { runInTenantScope } = require_("../src/lib/tenantScope.ts") as typeof import("../src/lib/tenantScope");
const { __setTenantEnforcingForTests } =
  require_("../src/lib/tenantEnforcement.ts") as typeof import("../src/lib/tenantEnforcement");
const { TenantScopeError } = require_("../src/lib/tenantGuard.ts") as typeof import("../src/lib/tenantGuard");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shipped = (rel: string) =>
  readFileSync(path.join(root, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const A = "tenant-a";
const B = "tenant-b";
const USER = { id: "user-1", name: "Rep", email: "rep@example.com", role: "sales" };
const OWNER = { ...USER, role: "owner" };

/**
 * Tenant A and tenant B each own a record with the SAME id. Unguessable ids are
 * not an access control, and a fixture that gave each tenant its own id space
 * would let a helper pass by accident. With the ids collided, the only thing
 * that can distinguish the two rows is the tenant predicate.
 */
const SHARED = "rec-shared";
/**
 * Tenant B's alone. The stub's id-list queries return every seeded row in every
 * tenant, so this id IS in tenant A's accessible-id list — which is precisely
 * how the real lists behaved for an unrestricted scope, and why the list alone
 * could never be the answer.
 */
const FOREIGN = "rec-foreign";
/** Belongs to nobody. A guessed id is still an id. */
const GHOST = "rec-ghost";

type HelperName =
  | "canAccessLead"
  | "canAccessContact"
  | "canAccessQuote"
  | "canAccessVehicle"
  | "canAccessJobCard"
  | "canAccessDocument"
  | "canAccessCase";

const HELPERS: Array<{
  helper: HelperName;
  model: spy.ModelName;
  viewAll: string;
  viewOwned: string;
}> = [
  { helper: "canAccessLead", model: "lead", viewAll: "leads.view_all", viewOwned: "leads.view_owned" },
  { helper: "canAccessContact", model: "contact", viewAll: "contacts.view_all", viewOwned: "contacts.view_owned" },
  { helper: "canAccessQuote", model: "quote", viewAll: "quotes.view_all", viewOwned: "quotes.view_owned" },
  { helper: "canAccessVehicle", model: "vehicle", viewAll: "vehicles.view_all", viewOwned: "vehicles.view_owned" },
  { helper: "canAccessJobCard", model: "jobCard", viewAll: "jobcards.view_all", viewOwned: "jobcards.view_owned" },
  { helper: "canAccessDocument", model: "document", viewAll: "documents.view_all", viewOwned: "documents.view_owned" },
  { helper: "canAccessCase", model: "customerCase", viewAll: "cases.view_all", viewOwned: "cases.view_owned" },
];

/**
 * Three rows per table: the id both tenants own, and the id only tenant B owns.
 *
 * `uploadedById` is on every row because the document scope needs it — a
 * document with no governing link and no uploader is refused by the precedence
 * rule, which would make the document assertions pass for the wrong reason.
 */
function seed() {
  const rows = (tenantId: string, id: string) => ({ id, tenantId, uploadedById: USER.id });
  spy.reset(
    Object.fromEntries(
      HELPERS.map(({ model }) => [model, [rows(A, SHARED), rows(B, SHARED), rows(B, FOREIGN)]]),
    ) as Partial<Record<spy.ModelName, spy.Row[]>>,
  );
}

const ask = (helper: HelperName, user: typeof USER, id: string) => permissions[helper](user, id);

/** The three callers whose id list comes back unrestricted or all-inclusive. */
function callers(entry: (typeof HELPERS)[number]) {
  return [
    { label: "an owner", user: OWNER, grants: [] as string[] },
    { label: `a ${entry.viewAll} holder`, user: USER, grants: [entry.viewAll] },
    { label: `a ${entry.viewOwned} holder whose id list contains it`, user: USER, grants: [entry.viewOwned] },
  ];
}

for (const entry of HELPERS) {
  for (const caller of callers(entry)) {
    test(`${entry.helper}: ${caller.label} is refused another tenant's record`, async () => {
      // THE DEFECT. Before the fix this returned true for every one of these
      // callers: the owner and the view_all holder because `ids === null`
      // short-circuited, and the view_owned holder because the id list itself is
      // built on basePrisma with no tenant predicate and so contained the other
      // tenant's id.
      seed();
      spy.setPermissions(caller.grants);
      await runInTenantScope({ tenantId: A, system: false }, async () => {
        assert.equal(
          await ask(entry.helper, caller.user, FOREIGN),
          false,
          "a record owned by another tenant is not this caller's to reach",
        );
      });
    });
  }

  test(`${entry.helper}: the caller's OWN record, sharing that id, is still reachable`, async () => {
    // The other half of the rule, and the one a careless fix breaks. Both tenants
    // own a record with this id; scoped to A, the helper must resolve A's copy and
    // allow it. A helper that simply refused everything would pass every test above.
    seed();
    for (const caller of callers(entry)) {
      spy.setPermissions(caller.grants);
      await runInTenantScope({ tenantId: A, system: false }, async () => {
        assert.equal(
          await ask(entry.helper, caller.user, SHARED),
          true,
          `${caller.label} must keep access to their own tenant's record`,
        );
      });
    }
  });

  test(`${entry.helper}: the refusal follows the scope, not a hard-coded tenant`, async () => {
    // Symmetry. Scoped to B, B's record is reachable — otherwise the test above
    // would also pass for a helper that had simply learned tenant A's name.
    seed();
    spy.setPermissions([entry.viewAll]);
    await runInTenantScope({ tenantId: B, system: false }, async () => {
      assert.equal(await ask(entry.helper, USER, FOREIGN), true);
      assert.equal(await ask(entry.helper, USER, SHARED), true, "B's copy of the shared id, not A's");
    });
  });

  test(`${entry.helper}: an id that exists nowhere is refused`, async () => {
    // `ids === null || ids.includes(id)` said yes to a string typed at random.
    // Every one of these helpers sits in front of a write.
    seed();
    spy.setPermissions([entry.viewAll]);
    await runInTenantScope({ tenantId: A, system: false }, async () => {
      assert.equal(await ask(entry.helper, USER, GHOST), false);
    });
  });

  test(`${entry.helper}: with enforcement off and no scope, nothing changes`, async () => {
    // The DEFAULT mode in every environment today. `establishStaffTenantScope`
    // enters no scope at all unless TENANT_ENFORCEMENT=enforce, so the predicate
    // is `{}` and the helper must behave exactly as it did before this change.
    // A fix that quietly filtered on `tenantId: null` here would empty the app.
    seed();
    spy.setPermissions([entry.viewAll]);
    assert.equal(await ask(entry.helper, USER, SHARED), true);
    assert.equal(await ask(entry.helper, USER, FOREIGN), true, "no scope is not a filter");
    assert.equal(await ask(entry.helper, USER, GHOST), false, "…but a row that does not exist still is not there");
  });

  test(`${entry.helper}: under enforcement a scopeless caller is refused, not unscoped`, async () => {
    // THE OWNER ESCAPE HATCH. Under enforcement `establishStaffTenantScope`
    // deliberately lets a GLOBAL OWNER continue with NO scope so the platform
    // console still works, and server actions run independently of the layout
    // that redirects them. Answering `{}` there would hand that owner every
    // tenant's records by id.
    seed();
    spy.setPermissions([entry.viewAll]);
    try {
      __setTenantEnforcingForTests(true);
      await assert.rejects(() => ask(entry.helper, OWNER, FOREIGN), TenantScopeError);
    } finally {
      __setTenantEnforcingForTests(null);
    }
  });
}

test("a refused id costs one indexed lookup and never builds the id list", async () => {
  // The judgement on the added query. Each helper now issues one primary-key
  // read before it answers, which is the cost `canAccessDocument` already
  // accepted. It is paid on the cheap side: the record resolves first, so a
  // miss short-circuits BEFORE the accessible-id list — and that list is the
  // expensive part (leads are raw SQL over teams; documents fan out into four
  // other scopes). For a bad id the helper now costs strictly LESS than before.
  seed();
  spy.setPermissions(["documents.view_owned"]);
  await runInTenantScope({ tenantId: A, system: false }, async () => {
    assert.equal(await permissions.canAccessDocument(USER, FOREIGN), false);
  });
  assert.deepEqual(
    spy.calls.map((call) => `${call.model}.${call.op}`),
    ["document.findFirst"],
    "a miss must not fan out into the accessible-id queries",
  );
});

test("a granted id pays exactly one extra query, and it is a keyed lookup", async () => {
  // The other side of the same judgement: on the hit path the record read is
  // additive. It is a lookup by primary key with an equality on an indexed
  // column, so it is the cheapest read in the file — and it is one per CALL, so
  // a caller that asks about N records in a loop pays N of them. None of the
  // current call sites loops; see the PR body.
  seed();
  spy.setPermissions(["leads.view_all"]);
  await runInTenantScope({ tenantId: A, system: false }, async () => {
    assert.equal(await permissions.canAccessLead(USER, SHARED), true);
  });
  const lookups = spy.calls.filter((call) => call.op === "findFirst");
  assert.equal(lookups.length, 1, "one record resolution per call, not one per candidate");
  assert.deepEqual(
    Object.keys((lookups[0].args.where ?? {}) as Record<string, unknown>).sort(),
    ["id", "tenantId"],
    "keyed on the primary key plus the tenant — both indexed",
  );
});

test("no canAccess* helper may answer from the id list alone", () => {
  // THE STRUCTURAL GUARD, and the reason this class is worth a test rather than
  // seven fixes. Six helpers were left behind when canAccessDocument was
  // repaired, because nothing in the repo said the shape was a rule. This
  // enumerates the helpers rather than listing them, so a SEVENTH one added
  // without a tenant-scoped record resolution fails here on the day it lands.
  const code = shipped("src/lib/permissions.ts");

  // Local zero-argument wrappers that just return the shared predicate count as
  // naming the tenant — `documentTenantWhere()` is one, and inlining it would
  // only make the document scope and the document check drift apart.
  const wrappers = [...code.matchAll(/function (\w+)\(\)[^\n]*\{\s*return activeTenantPredicate\(/g)].map(
    (match) => match[1],
  );
  assert.ok(
    wrappers.includes("documentTenantWhere"),
    "documentTenantWhere is the wrapper this allowance exists for — if it is gone, tighten the rule",
  );

  const declarations = [...code.matchAll(/export async function (canAccess\w+)\(/g)];
  const names = declarations.map((match) => match[1]);
  assert.deepEqual(
    names.sort(),
    [
      "canAccessCase",
      "canAccessContact",
      "canAccessDocument",
      "canAccessJobCard",
      "canAccessLead",
      "canAccessQuote",
      "canAccessVehicle",
    ],
    "the helper set changed — a new canAccess* helper must be added to this list AND carry a tenant predicate",
  );

  for (const declaration of declarations) {
    const name = declaration[1];
    const start = declaration.index!;
    // Bounded FROM the declaration; an unbounded indexOf can slice backwards to
    // empty and pass vacuously.
    const end = code.indexOf("\n}", start);
    assert.ok(end > start, `${name}: the slice ran backwards`);
    const body = code.slice(start, end);

    assert.match(
      body,
      /basePrisma\.\w+\.findFirst\(/,
      `${name} must RESOLVE the record on basePrisma — the scoped client would answer the tenant ` +
        "question by hiding the row, which reads as 'no such record' and leaves the predicate untested",
    );

    const predicate = new RegExp(
      `activeTenantPredicate\\(|(?:${wrappers.length ? wrappers.join("|") : "\\0"})\\(\\)`,
    );
    assert.match(
      body,
      predicate,
      `${name} queries basePrisma, which BYPASSES RLS, so it must name its tenant explicitly`,
    );

    assert.match(
      body,
      /if \(!\w+\) return false;/,
      `${name}: a record that is not in this tenant is a REFUSAL, never a fall-through`,
    );

    const tenantCheck = body.search(predicate);
    const shortCircuit = body.indexOf("ids === null");
    assert.ok(
      shortCircuit !== -1,
      `${name} no longer consults an accessible-id list — has the rule moved? Update this guard.`,
    );
    assert.ok(
      tenantCheck !== -1 && tenantCheck < shortCircuit,
      `${name}: the tenant check must PRECEDE the unrestricted short-circuit ` +
        `(${tenantCheck} vs ${shortCircuit}) — "unrestricted within my tenant" is never "unrestricted"`,
    );
  }
});

test("every helper's predicate says which check it came from", () => {
  // `activeTenantPredicate` throws under enforcement without a scope, and the
  // context string is the whole error message. Seven helpers sharing one label
  // would produce an exception nobody can locate.
  const code = shipped("src/lib/permissions.ts");
  const contexts = [...code.matchAll(/activeTenantPredicate\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(contexts.length >= 7, `expected a context per helper, found ${contexts.length}`);
  assert.equal(new Set(contexts).size, contexts.length, `duplicate predicate contexts: ${contexts.join(", ")}`);
});
