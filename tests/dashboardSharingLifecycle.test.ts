import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Module, { createRequire } from "node:module";

import { DEFAULT_TENANT_ID, soleActiveTenant } from "../src/lib/tenant";

/**
 * THE SHARING LIFECYCLE, RUN FOR REAL, IN TWO WORKSPACES, WITH ENFORCEMENT
 * DORMANT.
 *
 * WHY THIS FILE EXISTS. The tenant tests that shipped alongside this feature
 * hand-built a tenant-B dashboard row with `tenantId: "tenant_b"` already on it
 * and then checked that the read predicate excluded it from tenant A. That is a
 * test of `sharedInTenant()`, and `sharedInTenant()` was never the broken part.
 * The fixture asserted into existence the one thing the code did not do:
 *
 *   `createDashboard` created with NO tenantId, and the db.ts guard does not add
 *   one — `scopeArgs` returns its args untouched unless `tenantEnforcing()`,
 *   which is false in every environment today. So a user in tenant B created a
 *   dashboard, it was stored with `tenantId = NULL`, they published it, and
 *   `sharedInTenant("tenant_b")` requires `tenantId = 'tenant_b'` — so nobody
 *   else in tenant B could see it. `setDashboardShared()` only writes
 *   `sharedAt`/`sharedById`; it never corrects ownership. The cross-tenant leak
 *   was gone and sharing was dead for any workspace but the founding one.
 *
 * And the publish gate was `requireOwner()` — `role === "owner"`, a property of
 * the PLATFORM — so the provisioned owner of tenant B could not publish tenant
 * B's own dashboard, while the one account that passed the gate would find
 * nothing to publish, because `ownDashboard()` scopes to the caller's own rows.
 *
 * Neither defect can be caught by a constructed row. So nothing here constructs
 * one: every assertion is against what the SHIPPED server actions actually
 * persisted, read back through the SHIPPED store, in the order a person would do
 * it — create, publish, look.
 *
 * WHAT IS REAL AND WHAT IS A DOUBLE.
 *
 *   REAL, loaded from src/ and executed: `createDashboard`, `takeControl`,
 *   `setDashboardShared`, `saveDashboardLayout`, `dashboardsForViewer`,
 *   `dashboardBySlug`, `actingTenantId`, `viewerTenantId`, `sharedInTenant`,
 *   `decideBuilderTenant`, `writeTenantId`, and the whole of `lib/auth.ts` —
 *   `getCurrentUser`, `getActiveTenantId`, `requireOwner`, `requireTenantOwner`,
 *   `isTenantOwner`. The two gates are the thing under test in blocker 2, so
 *   neither is reimplemented here.
 *
 *   DOUBLED: the database (in-memory, NO tenant guard and NO RLS — which is
 *   precisely production today), the signed cookie, and `dashboard/data.ts`'s
 *   permission/module lookup. The session double resolves WHO through the same
 *   `requireUser()` every other caller uses, so there is exactly one answer to
 *   "who is asking" in this file.
 *
 * ENFORCEMENT IS LEFT DORMANT THROUGHOUT. Turning it on would make the db.ts
 * guard supply the tenantId and hide the very defect under test.
 */

/* ── the two workspaces ────────────────────────────────────────────── */

const A = DEFAULT_TENANT_ID;
const B = "tenant_b";

/** A tenant-B account that is NOT the platform owner. The person blocker 2 locked out. */
const B_OWNER = "u_b_owner";
/** Ordinary tenant-B staff. Must SEE what B publishes and must not be able to publish. */
const B_STAFF = "u_b_staff";
/** Tenant A's own provisioned owner — also not the platform owner. */
const A_OWNER = "u_a_owner";
/** Ordinary tenant-A staff. Must never see anything of B's. */
const A_STAFF = "u_a_staff";

const USERS: Record<string, { id: string; name: string; email: string; role: string }> = {
  [B_OWNER]: { id: B_OWNER, name: "Bea", email: "bea@b.example", role: "manager" },
  [B_STAFF]: { id: B_STAFF, name: "Ben", email: "ben@b.example", role: "sales" },
  [A_OWNER]: { id: A_OWNER, name: "Ava", email: "ava@a.example", role: "manager" },
  [A_STAFF]: { id: A_STAFF, name: "Alec", email: "alec@a.example", role: "sales" },
};
const TENANT_OF: Record<string, string> = {
  [B_OWNER]: B,
  [B_STAFF]: B,
  [A_OWNER]: A,
  [A_STAFF]: A,
};

/* ── the in-memory database ────────────────────────────────────────── */

type Row = Record<string, unknown>;
const TABLES: Record<string, Row[]> = {};
let seq = 0;

/**
 * The `where` semantics these call sites use, evaluated rather than pattern
 * matched. `OR` recurses because `sharedInTenant()` returns an object with its
 * own `OR` (the founding tenant also owns rows that predate tenancy) and the
 * switcher spreads that INSIDE another `OR`.
 */
function matches(row: Row, where: Row): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (key === "OR") {
      if (!(value as Row[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (key === "AND") {
      if (!(value as Row[]).every((clause) => matches(row, clause))) return false;
      continue;
    }
    const actual = row[key] ?? null;
    if (value !== null && typeof value === "object" && !(value instanceof Date)) {
      const filter = value as Row;
      if ("not" in filter) {
        if (filter.not === null ? actual === null : actual === filter.not) return false;
      }
      if ("startsWith" in filter) {
        if (typeof actual !== "string" || !actual.startsWith(filter.startsWith as string)) return false;
      }
      continue;
    }
    if (actual !== (value ?? null)) return false;
  }
  return true;
}

function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o) =>
    Object.entries(o).map(([field, dir]) => ({ field, dir: dir as string })),
  );
  return [...rows].sort((a, b) => {
    for (const { field, dir } of keys) {
      const l = a[field] as number | string | Date;
      const r = b[field] as number | string | Date;
      if (l === r) continue;
      const cmp = l < r ? -1 : 1;
      return dir === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

function table(name: string): Row[] {
  return (TABLES[name] ??= []);
}

function model(name: string) {
  return {
    create: ({ data }: { data: Row }) => {
      seq += 1;
      /*
       * `tenantId: data.tenantId ?? null` is the whole point of this double.
       *
       * A create that names no workspace stores NULL — it does not inherit one
       * from anywhere, because there is nowhere to inherit it from while the
       * guard is dormant. Remove the stamp from the action and this is exactly
       * what production writes.
       */
      const row: Row = {
        id: `${name}-${seq}`,
        createdAt: new Date(2026, 0, seq),
        tenantId: null,
        sharedAt: null,
        sharedById: null,
        sortOrder: 0,
        ...data,
      };
      table(name).push(row);
      return Promise.resolve({ ...row });
    },
    findMany: (args: { where?: Row; orderBy?: Row | Row[] } = {}) =>
      Promise.resolve(sorted(table(name).filter((r) => matches(r, args.where ?? {})), args.orderBy).map((r) => ({ ...r }))),
    findFirst: (args: { where?: Row; orderBy?: Row | Row[] } = {}) => {
      const hit = sorted(table(name).filter((r) => matches(r, args.where ?? {})), args.orderBy)[0];
      return Promise.resolve(hit ? { ...hit } : null);
    },
    findUnique: (args: { where?: Row } = {}) => {
      const hit = table(name).find((r) => matches(r, args.where ?? {}));
      return Promise.resolve(hit ? { ...hit } : null);
    },
    count: (args: { where?: Row } = {}) =>
      Promise.resolve(table(name).filter((r) => matches(r, args.where ?? {})).length),
    update: ({ where, data }: { where: Row; data: Row }) => {
      const hit = table(name).find((r) => matches(r, where));
      if (!hit) return Promise.reject(new Error(`no ${name} row for update`));
      Object.assign(hit, data);
      return Promise.resolve({ ...hit });
    },
  };
}

const db = new Proxy({} as Record<string, ReturnType<typeof model>>, {
  get(target, prop: string) {
    if (typeof prop !== "string" || prop.startsWith("$") || prop === "then") return undefined;
    /*
     * `tenantMember.findMany` carries a RELATION filter (`tenant: { active: true }`)
     * that the generic matcher has no business understanding. Every tenant in this
     * fixture is active, so the relation clause is dropped and the rest evaluated.
     */
    if (prop === "tenantMember") {
      const base = (target[prop] ??= model(prop));
      return {
        ...base,
        findMany: (args: { where?: Row } = {}) => {
          const { tenant: _relation, ...rest } = (args.where ?? {}) as Row;
          return base.findMany({ where: rest });
        },
      };
    }
    return (target[prop] ??= model(prop));
  },
});

/* ── the session ───────────────────────────────────────────────────── */

const TOKEN = "signed-session-token";
/** Who is holding the browser right now. Everything else derives from this. */
let acting: string = B_OWNER;
const signedInAs = (userId: string) => {
  acting = userId;
};

/** A `redirect()` — Next's control-flow throw, which is what both gates use to refuse. */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}

/* ── module interception ───────────────────────────────────────────── */

/**
 * The modules under test reach a live PrismaClient through `./db`, `server-only`
 * (not installed — Next vendors it behind an RSC export condition) and the whole
 * of Next's runtime. tsx compiles these tests to CommonJS, so each is swapped by
 * intercepting the loader and then requiring the REAL module through it.
 *
 * Every swap is anchored on the REQUESTING file, so a double cannot leak into a
 * module that merely happens to import the same specifier. Deliberately NOT
 * stubbed anywhere, because they are the things under test: `@/lib/actingTenant`,
 * `@/lib/dashboard/viewerTenant`, `@/lib/dashboard/sharedScope`, `./tenantWrite`,
 * `./flowTenantScope`, `./tenant`, `./tenantEnforcement`, and every exported gate
 * in `lib/auth.ts`.
 */
type Loader = (
  this: unknown,
  request: string,
  parent: { filename?: string } | undefined,
  isMain: boolean,
) => unknown;
const loaderKey = Module as unknown as { _load: Loader };
const realLoad = loaderKey._load;
const from = (parent: { filename?: string } | undefined, file: string) =>
  (parent?.filename ?? "").replace(/\\/g, "/").endsWith(file);

let authModule: typeof import("../src/lib/auth");

const AUTH_STUBS: Record<string, () => unknown> = {
  "next/headers": () => ({
    cookies: async () => ({
      get: (name: string) => (name === "denago_session" ? { value: TOKEN } : undefined),
      set: () => {},
      delete: () => {},
    }),
    headers: async () => new Map<string, string>(),
  }),
  "next/server": () => ({ NextResponse: { json: () => ({}) } }),
  "./db": () => ({ prisma: db, basePrisma: db }),
  "./settings": () => ({ getSetting: async () => null }),
  "./permissionQuery": () => ({ getUserPermissions: async () => [], usablePermissions: () => [] }),
  "./routeAccess": () => ({ routeGrants: () => [] }),
  "./userSecurity": () => ({
    getUserSecurityState: async () => ({ disabledAt: null, sessionVersion: 1 }),
    getUserSecurityStateFresh: async () => ({ disabledAt: null, sessionVersion: 1 }),
  }),
  "./provisioning": () => ({ ensureFoundingMembership: async () => {} }),
  "./tenantScopeEntry": () => ({
    // Dormant: no scope is established and none is needed. `{ ok: true }` is what
    // the real one returns when enforcement is off.
    validateInSystemScope: <T,>(fn: () => Promise<T>) => fn(),
    establishStaffTenantScope: async () => ({ ok: true }),
  }),
  "./tenantScope": () => ({
    withTenant: <T,>(_t: string | null, fn: () => Promise<T>) => fn(),
    withSystemScope: <T,>(fn: () => Promise<T>) => fn(),
    currentTenantScope: () => null,
  }),
  "./tenantContext": () => ({
    // The real shape: every ACTIVE membership, collapsed by the real
    // `soleActiveTenant`. This is what decides whether the session's `tid` claim
    // is still honoured, so the rule is executed rather than assumed.
    resolveActingTenant: async (userId: string) =>
      soleActiveTenant(
        (await db.tenantMember.findMany({ where: { userId } })).map((m) => m.tenantId as string),
      ),
  }),
  "./session": () => ({
    SESSION_COOKIE: "denago_session",
    DEFAULT_IDLE_MINUTES: 60,
    sessionCookieOptions: () => ({}),
    signFreshSession: async () => TOKEN,
    verifySession: async (token: string) =>
      token === TOKEN ? { sub: acting, sv: 1, jti: "jti-1", tid: TENANT_OF[acting] } : null,
  }),
};

loaderKey._load = function (this: unknown, request: string, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};

  // `redirect()` is how BOTH gates refuse, and `unstable_rethrow` is what keeps a
  // redirect from being swallowed by `asActionResult` and reported as a saved
  // change. Both are modelled, so a refused publish leaves the action as a throw
  // — which is what the browser sees as a navigation, not as `{ success }`.
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new RedirectSignal(to);
      },
      notFound: () => {
        throw new RedirectSignal("404");
      },
      unstable_rethrow: (error: unknown) => {
        if (error instanceof RedirectSignal) throw error;
      },
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };

  if (from(parent, "src/lib/auth.ts") && AUTH_STUBS[request]) return AUTH_STUBS[request]();

  // The one thing in tenantWrite that touches basePrisma is `withTenantWrite`,
  // and nothing here calls it. `writeTenantId()` itself — which answers NULL
  // while dormant, and is the reason every create was unowned — is real.
  if (from(parent, "src/lib/tenantWrite.ts") && request === "./db") return { basePrisma: {} };
  if (from(parent, "src/lib/actingTenant.ts") && request === "./auth") {
    return { getActiveTenantId: () => authModule.getActiveTenantId() };
  }

  if (request === "@/lib/db") return { prisma: db, basePrisma: db };
  if (request === "@/lib/auth") return authModule;
  if (request === "@/lib/audit") return { logAudit: async (entry: Row) => void audits.push(entry) };
  if (request === "@/lib/modules/enabled") return { getEnabledModuleIds: async () => [] };

  if (from(parent, "src/lib/dashboard/store.ts") && request === "./data") {
    return {
      // WHO is asking is resolved through the same `requireUser()` the actions
      // use, so the read path and the write path cannot disagree about the
      // session. Only the permission/module lookup is doubled.
      dashboardViewer: async () => ({
        user: await authModule.requireUser(),
        access: { permissions: new Set<string>(), modules: new Set<string>() },
      }),
    };
  }

  return realLoad.call(this, request, parent, isMain);
} as Loader;

const audits: Row[] = [];
const require_ = createRequire(import.meta.url);

authModule = require_("../src/lib/auth.ts") as typeof import("../src/lib/auth");
const actions = require_("../src/app/actions/dashboardConfig.ts") as typeof import("../src/app/actions/dashboardConfig");
const layoutActions = require_("../src/app/actions/dashboard.ts") as typeof import("../src/app/actions/dashboard");
const store = require_("../src/lib/dashboard/store.ts") as typeof import("../src/lib/dashboard/store");
const { tenantEnforcing } = require_("../src/lib/tenantEnforcement.ts") as typeof import("../src/lib/tenantEnforcement");

/* ── fixture ───────────────────────────────────────────────────────── */

function seed(): void {
  for (const key of Object.keys(TABLES)) delete TABLES[key];
  seq = 0;
  audits.length = 0;
  table("tenant").push(
    { id: A, name: "Founding workspace", active: true, ownerUserId: A_OWNER },
    { id: B, name: "Second workspace", active: true, ownerUserId: B_OWNER },
  );
  for (const [userId, tenantId] of Object.entries(TENANT_OF)) {
    table("user").push({ ...USERS[userId] });
    table("tenantMember").push({ id: `m-${userId}`, userId, tenantId });
  }
  table("userSession").push({ jti: "jti-1", revokedAt: null, lastActiveAt: new Date() });
}

/** The rows as the DATABASE holds them — never a shape this file constructed. */
const stored = (slug: string) => table("dashboard").filter((r) => r.slug === slug);

/* ── 1. the lifecycle ──────────────────────────────────────────────── */

test("enforcement is dormant, which is the whole premise", () => {
  // If this ever flips, the db.ts guard starts supplying the tenantId and every
  // assertion below would pass for a reason that has nothing to do with the fix.
  assert.equal(tenantEnforcing(), false);
});

test("a tenant-B owner creates a dashboard and the STORED row names tenant B", async () => {
  seed();
  signedInAs(B_OWNER);

  const created = await actions.createDashboard("Finance");
  assert.equal(created.error, undefined, created.error);

  const rows = stored("finance");
  assert.equal(rows.length, 1, "exactly one dashboard should have been written");
  // THE BLOCKER. Read back off the row the action persisted, not off a fixture.
  assert.equal(
    rows[0].tenantId,
    B,
    "a dashboard created in workspace B must be stored owned by B — the dormant guard adds nothing",
  );
  assert.notEqual(rows[0].tenantId, null, "an unowned row is one its own workspace cannot read back");
  assert.equal(rows[0].userId, B_OWNER);
});

test("the full lifecycle: B creates, B publishes, B sees it, A sees nothing", async () => {
  seed();

  // ── create, as the tenant-B owner (NOT the platform owner) ──
  signedInAs(B_OWNER);
  assert.equal((await actions.createDashboard("Finance")).error, undefined);

  // ── publish ──
  const published = await actions.setDashboardShared("finance", true);
  assert.equal(published.error, undefined, published.error);
  assert.ok(stored("finance")[0].sharedAt, "publishing must set sharedAt");
  assert.equal(stored("finance")[0].sharedById, B_OWNER);
  assert.equal(stored("finance")[0].tenantId, B, "publishing must not lose the workspace");
  assert.ok(audits.some((a) => a.action === "dashboard.shared"));

  // ── another tenant-B user lists it and opens it ──
  signedInAs(B_STAFF);
  const bList = await store.dashboardsForViewer();
  const bEntry = bList.find((d) => d.slug === "finance");
  assert.ok(bEntry, "a colleague in the same workspace must see what their owner published");
  assert.equal(bEntry.shared, true, "and must be told it is somebody else's, so it renders read-only");

  const bOpened = await store.dashboardBySlug("finance");
  assert.ok(bOpened, "and must be able to open it");
  assert.equal(bOpened.shared, true);
  assert.equal(bOpened.title, "Finance");

  // ── tenant A cannot list it or open it ──
  for (const outsider of [A_STAFF, A_OWNER]) {
    signedInAs(outsider);
    const aList = await store.dashboardsForViewer();
    assert.deepEqual(
      aList.filter((d) => d.slug === "finance"),
      [],
      `${outsider} is in another workspace and must not list B's published dashboard`,
    );
    assert.equal(
      await store.dashboardBySlug("finance"),
      null,
      `${outsider} must not be able to open it by address either`,
    );
  }
});

test("the leak in the other direction: A publishes, B still sees only its own", async () => {
  seed();

  signedInAs(A_OWNER);
  assert.equal((await actions.createDashboard("Sales")).error, undefined);
  assert.equal(stored("sales")[0].tenantId, A);
  assert.equal((await actions.setDashboardShared("sales", true)).error, undefined);

  // Both workspaces legitimately have a "Sales". B's must be the one B opens.
  signedInAs(B_OWNER);
  assert.equal((await actions.createDashboard("Sales")).error, undefined);
  assert.equal((await actions.setDashboardShared("sales", true)).error, undefined);

  signedInAs(B_STAFF);
  const opened = await store.dashboardBySlug("sales");
  assert.ok(opened);
  assert.equal(opened.id, stored("sales").find((r) => r.tenantId === B)?.id, "B must open B's row");

  const listed = await store.dashboardsForViewer();
  assert.equal(listed.filter((d) => d.slug === "sales").length, 1, "not one entry per workspace");
});

test("unpublishing takes it back, and keeps the record of who published", async () => {
  seed();
  signedInAs(B_OWNER);
  await actions.createDashboard("Finance");
  await actions.setDashboardShared("finance", true);
  assert.equal((await actions.setDashboardShared("finance", false)).error, undefined);

  assert.equal(stored("finance")[0].sharedAt, null);
  assert.equal(stored("finance")[0].sharedById, B_OWNER, "who exposed it must survive the flag");

  signedInAs(B_STAFF);
  assert.deepEqual((await store.dashboardsForViewer()).map((d) => d.slug), []);
  assert.equal(await store.dashboardBySlug("finance"), null);
});

/* ── 2. who may publish ────────────────────────────────────────────── */

test("the tenant-B OWNER may publish — the platform role is not the question", async () => {
  seed();
  signedInAs(B_OWNER);
  // The person blocker 2 locked out: `Tenant.ownerUserId` for the active
  // workspace, and emphatically NOT `role === "owner"`.
  assert.notEqual(USERS[B_OWNER].role, "owner");
  assert.equal(await authModule.isTenantOwner(), true);

  await actions.createDashboard("Finance");
  const result = await actions.setDashboardShared("finance", true);
  assert.equal(result.error, undefined, result.error);
  assert.ok(stored("finance")[0].sharedAt);
});

test("ordinary tenant-B staff may NOT publish, and are not shown the control", async () => {
  seed();
  signedInAs(B_STAFF);
  assert.equal(await authModule.isTenantOwner(), false, "the UI predicate must refuse them too");

  await actions.createDashboard("Scratch");
  await assert.rejects(
    () => actions.setDashboardShared("scratch", true),
    (error: unknown) => error instanceof RedirectSignal,
    "a non-owner must be refused by the gate, not by luck",
  );
  assert.equal(stored("scratch")[0].sharedAt, null, "and nothing may have been written");
});

test("a tenant owner cannot publish another workspace's dashboard", async () => {
  seed();
  signedInAs(B_OWNER);
  await actions.createDashboard("Finance");

  // A's owner passes the gate in A, and then finds nothing to publish: the second
  // half of the boundary is `ownDashboard`, which scopes to the caller's own rows.
  signedInAs(A_OWNER);
  const result = await actions.setDashboardShared("finance", true);
  assert.match(result.error ?? "", /could not be found/i);
  assert.equal(stored("finance")[0].sharedAt, null);
});

test("the UI predicate and the server gate are the same predicate", async () => {
  seed();
  for (const [userId, expected] of [
    [B_OWNER, true],
    [A_OWNER, true],
    [B_STAFF, false],
    [A_STAFF, false],
  ] as const) {
    signedInAs(userId);
    assert.equal(
      await authModule.isTenantOwner(),
      expected,
      `${userId}: the button must appear for exactly the people the action admits`,
    );
    if (expected) {
      assert.equal((await authModule.requireTenantOwner()).id, userId);
    } else {
      await assert.rejects(
        () => authModule.requireTenantOwner(),
        (error: unknown) => error instanceof RedirectSignal,
      );
    }
  }
});

/* ── 3. every other path that brings a row into existence ──────────── */

test("takeControl materialises the default dashboard owned by the acting workspace", async () => {
  seed();
  signedInAs(B_STAFF);
  const result = await actions.takeControl();
  assert.equal(result.error, undefined, result.error);

  const rows = table("dashboard");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenantId, B, "the first edit must not materialise an unowned row either");
  assert.equal(rows[0].userId, B_STAFF);
  assert.equal(rows[0].slug, store.DEFAULT_DASHBOARD_SLUG);

  // …and it is immediately their own, editable, in their own workspace.
  const opened = await store.dashboardBySlug(store.DEFAULT_DASHBOARD_SLUG);
  assert.ok(opened);
  assert.equal(opened.shared, false);
});

test("saveDashboardLayout stamps the layout row too", async () => {
  seed();
  signedInAs(B_STAFF);
  const { DEFAULT_LAYOUT } = require_("../src/lib/dashboard/registry.ts") as typeof import("../src/lib/dashboard/registry");
  const result = await layoutActions.saveDashboardLayout([...DEFAULT_LAYOUT].slice(0, 3));
  assert.equal(result.error, undefined, result.error);

  const layouts = table("dashboardLayout");
  assert.equal(layouts.length, 1);
  assert.equal(
    layouts[0].tenantId,
    B,
    "DashboardLayout is the sibling of Dashboard and is unowned the same way",
  );
});

test("every Dashboard/DashboardLayout create in the codebase names a workspace", () => {
  // The behavioural tests above cover the three paths that exist today. This is
  // what catches the fourth one being added without a stamp.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const src = (rel: string) => readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
  const sources = ["src/app/actions/dashboardConfig.ts", "src/app/actions/dashboard.ts"];

  let found = 0;
  for (const rel of sources) {
    const code = src(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(/prisma\.(dashboard|dashboardLayout)\.create\(\{([\s\S]*?)\n\s*\}\);/g)) {
      found += 1;
      assert.match(
        match[2],
        /tenantId: await actingTenantId\(\)/,
        `${rel}: ${match[1]}.create must name the acting workspace — the dormant guard adds nothing`,
      );
    }
  }
  assert.equal(found, 3, "expected createDashboard, takeControl and writeLayout");
});
