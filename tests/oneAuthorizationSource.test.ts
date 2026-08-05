import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  ROUTE_RULES,
  routeAllowed,
  routeGrants,
  ruleFor,
} from "../src/lib/routeAccess";

/**
 * There used to be TWO authorization systems deciding whether a user could reach
 * a screen, and they disagreed.
 *
 *   LEGACY  src/lib/access.ts — MODULES ("crm"/"workshop"/"reports"/"inbox")
 *           stored as a CSV on User.modules, carried as the JWT claim `mods`,
 *           enforced at the edge by the proxy and by requireCrm/requireWorkshop/
 *           requireInbox page guards.
 *   RBAC    src/lib/permissions.ts — UserRole/RolePermission, enforced by
 *           requirePermission/requireAnyPermission.
 *
 * The proxy consulted ONLY the CSV and never RBAC; RBAC never read User.modules.
 * So an admin could tick a permission for a role in /settings/access, watch the
 * page guard start allowing it, and the user would STILL be redirected to "/" by
 * the proxy because their module CSV lacked the flag — with nothing in the
 * product explaining the contradiction.
 *
 * These tests assert there is now exactly ONE source of that truth, and that the
 * edge and the page guards cannot answer differently.
 *
 * NOTE: `src/lib/modules/registry.ts` has an unrelated ModuleId namespace
 * (core/inbox/support/marketing/…). That is the TENANT feature pack — what a
 * workspace has bought, not what a user may do — and it deliberately survives.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/** Source with comments stripped — a naive regex otherwise matches the very
 *  comment that documents the fix. */
const shipped = (rel: string) =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const sourceFiles = walk(path.join(root, "src")).filter((f) => /\.tsx?$/.test(f));
const rel = (abs: string) => abs.slice(root.length + 1).replace(/\\/g, "/");

/* ── the retired authority is really gone ─────────────────────────────── */

test("the legacy per-user module authority no longer exists", () => {
  assert.equal(
    existsSync(path.join(root, "src", "lib", "access.ts")),
    false,
    "src/lib/access.ts was the second authorization system — it must not come back",
  );

  const importers = sourceFiles.filter((f) =>
    /from\s+["'](?:@\/lib\/access|\.{1,2}\/access|\.{1,2}\/lib\/access)["']/.test(readFileSync(f, "utf8")),
  );
  assert.deepEqual(importers.map(rel), [], "nothing may import the retired module-flag module");
});

test("no code decides access from the per-user module CSV any more", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles) {
    const code = shipped(rel(file));
    // The retired guards, the retired admin write, and any read of the per-user
    // CSV. `Tenant.modules` (the feature pack) is a different column and is not
    // matched: these patterns are all user-shaped.
    for (const pattern of [
      /\brequireAnyModule\s*\(/,
      /\brequireCrm(?:OrWorkshop)?\s*\(/,
      /\brequireWorkshop\s*\(/,
      /\brequireInbox\s*\(/,
      /\brequireOperational\s*\(/,
      /\bsetUserModules\s*\(/,
      /\bhasModule\s*\(\s*user\b/,
      /\buser\.modules\b/,
    ]) {
      if (pattern.test(code)) offenders.push(`${rel(file)} — ${pattern}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These read or write the retired per-user module CSV. Authorization comes from RBAC " +
      "(src/lib/routeAccess.ts + src/lib/permissions.ts) only:\n  " + offenders.join("\n  "),
  );
});

test("the session no longer carries a hand-authored module claim", () => {
  const session = shipped("src/lib/session.ts");
  assert.doesNotMatch(session, /\bmods\s*:/, "the `mods` claim was the module CSV — it is retired");
  assert.match(session, /\brg\s*:\s*string/, "the session must carry the derived route-grant claim");
  assert.doesNotMatch(
    session,
    /\bmodules\s*:\s*string/,
    "signFreshSession must take derived grants, never a module CSV",
  );
});

/* ── one table, consulted by both sides ───────────────────────────────── */

test("the proxy gates routes from the single route table and nothing else", () => {
  const proxy = shipped("src/proxy.ts");
  assert.match(
    proxy,
    /import\s*\{\s*routeAllowed\s*\}\s*from\s*"@\/lib\/routeAccess"/,
    "the edge check must come from the one route table",
  );
  assert.match(
    proxy,
    /grants:\s*result\.payload\.rg\s*\?\?\s*""/,
    "the proxy must read the DERIVED grant claim, not an independently-authored one",
  );
  assert.doesNotMatch(proxy, /payload\.mods/, "the retired module claim must not be consulted");
});

test("every route the proxy guards is guarded identically by its own pages", () => {
  // The disagreement bug in one assertion: the edge and the page must reach the
  // same verdict because they read the SAME rule. An owner-only rule is enforced
  // by requireOwner(); a permission rule by requireRoute("<prefix>"), which looks
  // the rule up in ROUTE_RULES rather than restating the permissions.
  const appDir = path.join(root, "src", "app", "(app)");
  const offenders: string[] = [];

  for (const rule of ROUTE_RULES) {
    const segment = path.join(appDir, rule.prefix.slice(1));
    const files = walk(segment).filter((f) => /[\\/](page|layout)\.tsx$/.test(f));
    assert.ok(files.length > 0, `expected pages under ${rule.prefix}`);

    for (const file of files) {
      const code = shipped(rel(file));
      const ok =
        "owner" in rule
          ? /\brequireOwner\s*\(\s*\)/.test(code)
          : new RegExp(`requireRoute\\(\\s*"${rule.prefix}"\\s*\\)`).test(code);
      if (!ok) offenders.push(`${rel(file)} (rule ${rule.prefix})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "These pages are gated by the proxy but do not apply the SAME rule themselves, so the " +
      "edge and the page can disagree:\n  " + offenders.join("\n  "),
  );
});

test("requireRoute reads the shared table instead of restating permissions", () => {
  const permissions = shipped("src/lib/permissions.ts");
  assert.match(
    permissions,
    /export async function requireRoute\(/,
    "the page-side guard for a gated route must exist",
  );
  assert.match(
    permissions,
    /ruleFor\(route\)/,
    "requireRoute must look the rule up in ROUTE_RULES — a restated permission list is a second source",
  );
  assert.match(
    permissions,
    /requireAnyPermission\(\.\.\.rule\.anyOf\)/,
    "requireRoute must enforce exactly the permissions the edge rule names",
  );
});

/* ── the claim is DERIVED, never authored ─────────────────────────────── */

test("route grants are derived from RBAC at exactly one site", () => {
  const producers = sourceFiles.filter((f) => /\brouteGrants\s*\(/.test(shipped(rel(f))));
  assert.deepEqual(
    producers.map(rel).sort(),
    ["src/lib/auth.ts", "src/lib/routeAccess.ts"],
    "only the mint site may produce grants — a second producer is a second authority",
  );

  const auth = shipped("src/lib/auth.ts");
  assert.match(
    auth,
    /routeGrants\(\s*user\.role,\s*usablePermissions\(await getUserPermissions\(user\.id\)\)/,
    "the claim must be derived from the user's LIVE RBAC, not from a stored column",
  );
  assert.match(auth, /signFreshSession\(\s*\{\s*\.\.\.user,\s*grants,/, "the derived grants must be what is signed");
});

test("a permission change invalidates every session carrying a stale grant", () => {
  // The derived claim is only safe because it cannot outlive the RBAC it was
  // derived from: each write bumps User.sessionVersion, and getCurrentUser
  // refuses a session whose `sv` no longer matches. Without these, granting a
  // permission would leave the old `rg` in place and reproduce the original bug
  // in a subtler form.
  const accessControl = shipped("src/app/actions/accessControl.ts");
  for (const action of ["updateRolePermissions", "updateUserRoles"]) {
    const start = accessControl.indexOf(`export async function ${action}(`);
    assert.notEqual(start, -1, `${action} not found — was it renamed?`);
    const rest = accessControl.slice(start + 1);
    const next = rest.indexOf("\nexport async function ");
    const body = next === -1 ? rest : rest.slice(0, next);
    assert.match(
      body,
      /"sessionVersion"\s*=\s*"sessionVersion"\s*\+\s*1/,
      `${action} changes what a user may do, so it must revoke the sessions whose route grants it just invalidated`,
    );
  }

  assert.match(
    shipped("src/lib/auth.ts"),
    /if \(security\.sessionVersion !== session\.sv\) return null;/,
    "a superseded session must be rejected, or the bump above buys nothing",
  );
});

/* ── behaviour: the reported bug, and fail-closed ─────────────────────── */

test("granting the permission is enough — the edge stops disagreeing", () => {
  for (const rule of ROUTE_RULES) {
    if (!("anyOf" in rule)) continue;
    for (const permission of rule.anyOf) {
      // Exactly what an admin ticking one permission in /settings/access produces.
      const grants = routeGrants("member", [permission]);
      assert.equal(
        routeAllowed(rule.prefix, { role: "member", grants }),
        true,
        `${permission} opens ${rule.prefix} on the page but not at the edge — the original bug`,
      );
      assert.equal(
        routeAllowed(`${rule.prefix}/anything`, { role: "member", grants }),
        true,
        `${rule.prefix} sub-paths must follow the same rule`,
      );
    }
  }
});

test("no permission means no route — and an owner-only route stays owner-only", () => {
  const none = routeGrants("member", []);
  for (const rule of ROUTE_RULES) {
    assert.equal(
      routeAllowed(rule.prefix, { role: "member", grants: none }),
      false,
      `${rule.prefix} must be closed to a user holding nothing`,
    );
    if ("owner" in rule) {
      // No permission can ever open it: routeGrants must not emit owner rules
      // for a member, however many permissions they hold.
      const everything = routeGrants("member", ROUTE_RULES.flatMap((r) => ("anyOf" in r ? [...r.anyOf] : [])));
      assert.equal(
        routeAllowed(rule.prefix, { role: "member", grants: everything }),
        false,
        `${rule.prefix} is owner-only — no permission grant may open it`,
      );
    }
    assert.equal(
      routeAllowed(rule.prefix, { role: "owner", grants: "" }),
      true,
      `an owner must reach ${rule.prefix}; owner is the same predicate requireOwner() applies`,
    );
  }
});

test("a token minted before the grant claim existed fails CLOSED", () => {
  // Legacy `mods` tokens have no `rg`, and the proxy passes "" for it. Denying
  // costs a non-owner the gated routes until their next sign-in; allowing would
  // leave every one of them open to any authenticated user.
  for (const rule of ROUTE_RULES) {
    assert.equal(
      routeAllowed(rule.prefix, { role: "member", grants: "" }),
      false,
      `a claimless token must not open ${rule.prefix}`,
    );
  }
  assert.equal(routeAllowed("/leads", { role: "member", grants: "" }), true, "ungated routes stay ungated here");
  assert.equal(ruleFor("/leads"), undefined);
});

/* ── the nav cannot advertise a route the guard refuses ───────────────── */

test("nav links use the same permissions as the route rules they point at", () => {
  // A link shown by one rule and a page guarded by another is the same class of
  // bug at a smaller scale: the user clicks something the product offered them
  // and is redirected away.
  const nav = shipped("src/components/nav-config.ts");
  const linked = new Map<string, string[]>();
  for (const match of nav.matchAll(/can\(([^)]*)\)\)\s*\w+\.push\(\{\s*href:\s*"([^"]+)"/g)) {
    const keys = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    linked.set(match[2], keys);
  }
  assert.ok(linked.size > 5, "expected to parse the nav's permission-gated links");

  for (const rule of ROUTE_RULES) {
    const keys = linked.get(rule.prefix);
    if (!keys) continue; // not linked from the sidebar at all
    assert.deepEqual(
      [...keys].sort(),
      "anyOf" in rule ? [...rule.anyOf].sort() : [],
      `the nav shows ${rule.prefix} on different permissions than the route rule enforces`,
    );
  }

  assert.doesNotMatch(
    nav,
    /hasModule|permissionList\.length === 0/,
    "the nav must be built from RBAC alone — a module-CSV fallback is a second source",
  );
});

/* ── tenant-owner routes: a workspace's own screen, its own owner ────── */

/**
 * `owner: true` means the PLATFORM owner — one person, globally. Applied to a
 * screen that shows a workspace its own data, that is the wrong predicate in
 * both directions: the provisioned owner of tenant B cannot open tenant B's
 * screen, and the platform owner opens whichever tenant their session happens
 * to be scoped to. `tenantOwner: true` is the predicate those screens want.
 */

test("a tenantOwner route opens for the workspace's owner and for nobody else's RBAC", () => {
  const rules = ROUTE_RULES.filter((rule) => "tenantOwner" in rule);
  assert.ok(
    rules.length > 0,
    "no tenantOwner rule exists — this suite would be asserting nothing",
  );

  // Every permission the catalogue can grant, held by someone who is NOT the
  // owner of their workspace. Tenant ownership is a row, and no amount of RBAC
  // is a substitute for it.
  const everyPermission = ROUTE_RULES.flatMap((r) => ("anyOf" in r ? [...r.anyOf] : []));

  for (const rule of rules) {
    const tenantOwner = routeGrants("member", [], { tenantOwner: true });
    assert.equal(
      routeAllowed(rule.prefix, { role: "member", grants: tenantOwner }),
      true,
      `the provisioned owner of a tenant must reach ${rule.prefix} without the platform role`,
    );
    assert.equal(
      routeAllowed(`${rule.prefix}/anything`, { role: "member", grants: tenantOwner }),
      true,
      `${rule.prefix} sub-paths must follow the same rule`,
    );

    for (const [label, grants] of [
      ["holding every permission in the catalogue", routeGrants("member", everyPermission)],
      ["explicitly not the tenant owner", routeGrants("member", everyPermission, { tenantOwner: false })],
      ["with the flag omitted entirely", routeGrants("member", everyPermission, {})],
      ["with no options argument at all", routeGrants("member", everyPermission)],
    ] as const) {
      assert.equal(
        routeAllowed(rule.prefix, { role: "member", grants }),
        false,
        `${rule.prefix} opened for a non-owner ${label} — tenant ownership is not a permission`,
      );
    }

    assert.equal(
      routeAllowed(rule.prefix, { role: "member", grants: "" }),
      false,
      `a token minted before ${rule.prefix} existed must fail CLOSED, exactly as permission grants do`,
    );
    assert.equal(
      routeAllowed(rule.prefix, { role: "owner", grants: "" }),
      true,
      `the platform owner must still reach ${rule.prefix}`,
    );
  }
});

test("no rule declares two predicates", () => {
  for (const rule of ROUTE_RULES) {
    const declared = ["owner", "tenantOwner", "anyOf"].filter((key) => key in rule);
    assert.equal(
      declared.length,
      1,
      `${rule.prefix} declares ${declared.join(" + ")} — one rule, one predicate, or the edge and the page can diverge again`,
    );
  }
});

test("the tenant-owner grant is decided against THIS session's tenant", () => {
  // The edge has no database, so this is the one place the row can be read. It
  // must be the tenant the session is actually stamped with (sessionTenantId,
  // which the tenantless fallback may have just cleared) — not the tenant that
  // was resolved earlier — or a session could carry a grant for a workspace it
  // is not scoped to.
  const auth = shipped("src/lib/auth.ts");
  const start = auth.indexOf("let tenantOwner = false;");
  assert.notEqual(start, -1, "the mint site no longer resolves tenant ownership");
  const mint = auth.slice(start, auth.indexOf("signFreshSession", start));

  assert.match(
    mint,
    /where:\s*\{\s*id:\s*sessionTenantId\s*\}/,
    "the ownership row must be read for the tenant this session is stamped with",
  );
  assert.match(
    mint,
    /ownerUserId === user\.id/,
    "the grant must be the identity comparison requireTenantOwner() makes, not a looser one",
  );
  assert.match(
    mint,
    /routeGrants\(\s*user\.role,\s*usablePermissions\([^)]*\)\),?\s*\{\s*tenantOwner\s*\}/,
    "the resolved flag must be what routeGrants is given",
  );
  // A read that throws must cost the owner a screen, never the login.
  assert.match(mint, /catch \(e\) \{/, "a failed ownership read must not break sign-in");
});

test("requireRoute enforces tenantOwner rules live, against the database", () => {
  // The grant in the token is a cache of a decision made at sign-in. Someone who
  // stopped owning their workspace still carries it until the token expires, so
  // the page guard has to re-resolve rather than trust it.
  const permissions = shipped("src/lib/permissions.ts");
  assert.match(
    permissions,
    /if \("tenantOwner" in rule\) return requireTenantOwner\(\);/,
    "requireRoute must answer a tenantOwner rule with requireTenantOwner() — a restated predicate is a second source",
  );
});

test("the repairs surface is guarded as a tenant-owner surface, everywhere", () => {
  // The page is not the boundary: a server action is reachable by direct POST,
  // so each one states the rule where the mutation happens.
  const page = shipped("src/app/(app)/repairs/page.tsx");
  assert.match(
    page,
    /await requireRoute\("\/repairs"\)/,
    "the page must consult ROUTE_RULES rather than restate a predicate",
  );

  const actions = shipped("src/app/actions/repairs.ts");
  const exported = [...actions.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(exported.length >= 2, "expected the repairs actions to still be exported");
  for (const name of exported) {
    const start = actions.indexOf(`export async function ${name}(`);
    const rest = actions.slice(start + 1);
    const next = rest.indexOf("\nexport async function ");
    const body = next === -1 ? rest : rest.slice(0, next);
    assert.match(
      body,
      /await requireTenantOwner\(\)/,
      `${name} is reachable by direct POST and must apply the same rule the page does`,
    );
  }

  for (const [label, source] of [["page", page], ["actions", actions]] as const) {
    assert.doesNotMatch(
      source,
      /\brequireOwner\(/,
      `the repairs ${label} must not require the PLATFORM role — that locks every other workspace's owner out of their own inbox`,
    );
  }
});
