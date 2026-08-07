import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";
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

/**
 * The permission catalogue, read from source rather than imported: permissions.ts
 * pulls in the Prisma client and next/navigation, and a unit test that has to
 * stand a database up to answer a question about a string list is not a unit test.
 */
const CATALOGUE = (() => {
  const source = shipped("src/lib/permissions.ts");
  const start = source.indexOf("export const PERMISSIONS = [");
  if (start === -1) throw new Error("PERMISSIONS not found in src/lib/permissions.ts — was it renamed?");
  const end = source.indexOf("]", start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]);
})();

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

/**
 * Every permission-gated nav link, with the permission keys that make it appear.
 *
 * Parsed from the AST, not a regex over the text. The regex this replaced only
 * ever matched a single-line `if (can(…)) list.push({ href: … })`, so the
 * marketing block, the workshop calendar's two-`can` condition and every link
 * inside a pushed group were invisible to it — and an invisible link is one
 * nothing checks.
 */
function navLinks(): Array<{ href: string; keys: string[]; admin: boolean }> {
  const file = path.join(root, "src", "components", "nav-config.ts");
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const links: Array<{ href: string; keys: string[]; admin: boolean }> = [];

  /** The `can("a","b")` keys — and whether `isAdmin` alone — guard a branch. */
  function guardOf(expression: ts.Expression) {
    const keys: string[] = [];
    let admin = false;
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "can") {
        for (const argument of node.arguments) {
          if (ts.isStringLiteral(argument)) keys.push(argument.text);
        }
      }
      if (ts.isIdentifier(node) && node.text === "isAdmin") admin = true;
      ts.forEachChild(node, walk);
    };
    walk(expression);
    return { keys, admin };
  }

  function visit(node: ts.Node, keys: string[], admin: boolean) {
    if (ts.isIfStatement(node)) {
      const guard = guardOf(node.expression);
      visit(node.expression, keys, admin);
      visit(node.thenStatement, [...keys, ...guard.keys], admin || guard.admin);
      // The else branch is NOT covered by the condition's grant.
      if (node.elseStatement) visit(node.elseStatement, keys, admin);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === "href" &&
          ts.isStringLiteral(property.initializer)
        ) {
          links.push({ href: property.initializer.text, keys: [...keys], admin });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, keys, admin));
  }

  const buildNav = source.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "buildNav",
  );
  assert.ok(buildNav, "buildNav not found in nav-config.ts — was it renamed?");
  visit(buildNav, [], false);
  return links;
}

/**
 * Permission-gated nav links that deliberately have NO entry in ROUTE_RULES.
 *
 * ROUTE_RULES is the EDGE pre-filter: a route earns a rule when there is value
 * in refusing it before any page code runs. Everything below is gated by its own
 * page or segment layout instead, on the very permission the nav link uses — so
 * the link and the guard still answer to one authority, there is simply no
 * second copy of the answer at the edge.
 *
 * An entry here is a claim, not a waiver: the test below opens each route's page
 * and layout chain and fails unless a real RBAC guard is there. `requireOwner`
 * deliberately does NOT count — a permission-gated link over an owner-gated page
 * is exactly the /journeys bug this file exists to prevent.
 */
const EDGE_EXEMPT_NAV_ROUTES = new Set([
  "/reports", "/targets", "/forecast",
  "/inbox",
  "/calendar", "/test-drives", "/leads", "/quotes", "/signatures", "/deliveries",
  "/contacts", "/activities", "/documents",
  "/cases",
  "/marketing/overview", "/marketing/campaigns", "/marketing/calendar",
  "/marketing/audiences", "/marketing/templates",
  "/marketing/surveys", "/marketing/surveys/insights",
  "/referrals", "/stock",
  "/workshop-calendar", "/vehicles", "/service-due", "/warranty",
  "/jobcards", "/jobcards/insights", "/parts",
  "/library", "/document-studio",
  "/audit",
]);

/**
 * Exempt routes whose page does NOT in fact enforce the permission its nav link
 * is shown on — a KNOWN GAP, recorded rather than waved through.
 *
 * /leads renders the whole pipeline from `getCurrentUser()` alone: `hasPermission`
 * appears in it, but only to decide which BUTTONS to draw, so a signed-in user
 * holding no lead permission at all can open the URL the sidebar hides from them
 * and read every open lead. That is a lead-scope fix, not a route-rule one, and it
 * is deliberately out of scope here. Listing it keeps the invariant above sharp
 * for every other route instead of loosening the guard pattern to accommodate one.
 *
 * The test prunes this list: give /leads a real guard and it will tell you to
 * remove the entry.
 */
const PAGE_GUARD_GAPS = new Set(["/leads"]);

/** A guard that resolves live RBAC. requireOwner is not one of these. */
const RBAC_PAGE_GUARD = /\b(?:requireRoute|requirePermission|requireAnyPermission|require\w+Access)\s*\(/;

/** The page for `href`, plus every layout above it — the whole guard chain. */
function routeGuardChain(href: string): string[] {
  const segments = href.slice(1).split("/");
  const files: string[] = [];
  for (let depth = 0; depth <= segments.length; depth++) {
    const dir = path.join(root, "src", "app", "(app)", ...segments.slice(0, depth));
    for (const name of depth === segments.length ? ["layout.tsx", "page.tsx"] : ["layout.tsx"]) {
      const file = path.join(dir, name);
      if (existsSync(file)) files.push(file);
    }
  }
  return files;
}

test("every permission-gated nav link points at a route whose authority is written down", () => {
  // THE INVERSION. This used to iterate ROUTE_RULES and look up each rule's nav
  // link, so a link pointing at a route with NO rule was never examined — which
  // is precisely how /journeys shipped advertising `journeys.manage` in the
  // sidebar while its pages demanded requireOwner() and no rule gated the prefix
  // at all. Iterating the LINKS makes an unruled route a finding, not a blind
  // spot. Start from what the product offers the user, not from what is already
  // written down.
  const links = navLinks();
  assert.ok(links.length > 20, `expected to parse the nav's links, found ${links.length}`);

  const gated = links.filter((link) => link.keys.length > 0);
  assert.ok(gated.length > 5, "expected the nav's permission-gated links");

  const unaccounted: string[] = [];
  const mismatched: string[] = [];
  const unguarded: string[] = [];
  const closedGaps: string[] = [];
  const unusedExemptions = new Set(EDGE_EXEMPT_NAV_ROUTES);

  for (const link of gated) {
    const rule = ruleFor(link.href);
    if (!rule) {
      if (!EDGE_EXEMPT_NAV_ROUTES.has(link.href)) {
        unaccounted.push(`${link.href} (shown on ${link.keys.join(", ")})`);
        continue;
      }
      unusedExemptions.delete(link.href);
      const chain = routeGuardChain(link.href);
      const guarded = chain.some((file) => RBAC_PAGE_GUARD.test(shipped(rel(file))));
      if (guarded && PAGE_GUARD_GAPS.has(link.href)) closedGaps.push(link.href);
      if (!guarded && !PAGE_GUARD_GAPS.has(link.href)) {
        unguarded.push(`${link.href} — ${chain.map(rel).join(", ") || "no page found"}`);
      }
      continue;
    }
    if (!("anyOf" in rule)) {
      mismatched.push(`${link.href} is owner-only at the edge but advertised on ${link.keys.join(", ")}`);
      continue;
    }
    const keys = [...new Set(link.keys)].sort();
    const allowed = [...rule.anyOf].sort();
    if (keys.join("|") !== allowed.join("|")) {
      mismatched.push(`${link.href}: nav ${keys.join(", ")} vs rule ${allowed.join(", ")}`);
    }
  }

  assert.deepEqual(
    unaccounted,
    [],
    "These nav links are shown on a permission, but the route they point at has no rule in " +
      "ROUTE_RULES and is not listed in EDGE_EXEMPT_NAV_ROUTES. Decide which it is — a rule (the " +
      "edge enforces it too) or an exemption (the page enforces it alone):\n  " + unaccounted.join("\n  "),
  );
  assert.deepEqual(
    mismatched,
    [],
    "The nav shows these on different permissions than the route rule enforces, so the product " +
      "offers a link the guard refuses:\n  " + mismatched.join("\n  "),
  );
  assert.deepEqual(
    unguarded,
    [],
    "These are exempt from the edge rule on the promise that their own page enforces the " +
      "permission — and it does not. An owner-only guard under a permission-gated link is the " +
      "/journeys bug:\n  " + unguarded.join("\n  "),
  );
  assert.deepEqual(
    closedGaps,
    [],
    `PAGE_GUARD_GAPS lists routes that now DO enforce their permission — prune them so the list keeps meaning something: ${closedGaps.join(", ")}`,
  );
  assert.deepEqual(
    [...unusedExemptions],
    [],
    `EDGE_EXEMPT_NAV_ROUTES lists routes the nav no longer links on a permission — prune them: ${[...unusedExemptions].join(", ")}`,
  );
});

test("an owner-only nav link is never advertised on a permission", () => {
  // The mirror image: a link the sidebar shows only to `isAdmin` may point at an
  // owner rule or at no rule, but a permission rule would mean the product hides
  // a screen from someone the guard would have admitted.
  for (const link of navLinks()) {
    if (!link.admin || link.keys.length > 0) continue;
    const rule = ruleFor(link.href);
    if (!rule) continue;
    // `tenantOwner` counts as an ownership predicate here, not a permission.
    // The rule this test enforces is "an owner-only link must not point at a
    // rule the guard would open on a PERMISSION" — a workspace-owner rule is
    // still ownership, so it satisfies that. Without this the repairs inbox,
    // which is a tenantOwner surface, reads as a nav link hiding a screen the
    // guard allows.
    assert.ok(
      "owner" in rule || "tenantOwner" in rule,
      `${link.href} is shown only to owners but its route rule grants it on ${
        "anyOf" in rule ? rule.anyOf.join(", ") : "?"
      } — the nav hides a screen the guard allows`,
    );
  }
});

test("the nav is built from RBAC alone", () => {
  assert.doesNotMatch(
    shipped("src/components/nav-config.ts"),
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

/* ── journeys: the disagreement this rule was added to end ────────────── */

/**
 * The page-guard verdict for a member holding `held`.
 *
 * Models `requireRoute` (permissions.ts) rather than re-deciding anything: it
 * reads the SAME rule and applies `requireAnyPermission(...rule.anyOf)`, and the
 * test above ("requireRoute reads the shared table…") pins that delegation. Its
 * purpose here is to be compared against `routeAllowed` — the two sides
 * disagreeing IS the bug.
 */
function pageGuardAllows(route: string, role: string, held: Iterable<string>): boolean {
  const rule = ruleFor(route);
  if (!rule) return true;
  if (role === "owner") return true;
  if ("owner" in rule) return false;
  // A tenantOwner rule is decided by an ownership ROW, which this helper has no
  // way to know about — it is given permissions, not a tenant. requireRoute
  // answers such a rule with requireTenantOwner(), so no set of permissions
  // opens it, and false is the honest answer here. (Only permission-based routes
  // are compared through this helper; the tenantOwner rules have their own tests
  // above.)
  if ("tenantOwner" in rule) return false;
  const permissions = new Set(held);
  return rule.anyOf.some((key: string) => permissions.has(key));
}

/** The builder, and the trace beneath it — the sub-path must follow the prefix. */
const JOURNEY_ROUTES = ["/journeys", "/journeys/activity"];

test("a member granted journeys.manage reaches journeys — at the edge AND on the page", () => {
  // Verbatim the lived failure: an admin ticks journeys.manage for a role, the
  // sidebar shows "Journeys", the user clicks it and is redirected to "/".
  const held = ["journeys.manage"];
  const grants = routeGrants("member", held);
  for (const route of JOURNEY_ROUTES) {
    assert.equal(
      routeAllowed(route, { role: "member", grants }),
      true,
      `${route} must open at the edge for a journeys.manage holder`,
    );
    assert.equal(
      pageGuardAllows(route, "member", held),
      true,
      `${route} must open at the page guard for a journeys.manage holder`,
    );
  }
  assert.equal(grants.includes("/journeys"), true, "the minted claim must carry the journeys grant");
});

test("a member holding nothing cannot reach journeys", () => {
  const grants = routeGrants("member", []);
  for (const route of JOURNEY_ROUTES) {
    assert.equal(routeAllowed(route, { role: "member", grants }), false, `${route} must stay closed at the edge`);
    assert.equal(pageGuardAllows(route, "member", []), false, `${route} must stay closed at the page guard`);
  }
});

test("every OTHER permission in the catalogue still leaves journeys closed", () => {
  // Delegable is not the same as open: journeys send mail and WhatsApp to real
  // customers, so the one key that opens them must be the only one that does.
  const others = CATALOGUE.filter((key) => key !== "journeys.manage");
  assert.ok(others.length > 50, "expected the permission catalogue");
  const grants = routeGrants("member", others);
  for (const route of JOURNEY_ROUTES) {
    assert.equal(
      routeAllowed(route, { role: "member", grants }),
      false,
      `${route} opened for a member holding every permission EXCEPT journeys.manage`,
    );
    assert.equal(pageGuardAllows(route, "member", others), false, `${route} opened at the page guard without journeys.manage`);
  }
});

test("the edge and the journeys pages cannot answer differently", () => {
  // The whole point of one table: sweep every subset that matters and assert the
  // two verdicts agree. A rule change that opens one side alone fails here.
  const holdings: string[][] = [
    [],
    ["journeys.manage"],
    ["campaigns.manage"],
    ["journeys.manage", "campaigns.manage"],
    CATALOGUE.filter((key) => key !== "journeys.manage"),
    [...CATALOGUE],
  ];
  for (const held of holdings) {
    for (const role of ["member", "owner"]) {
      const grants = routeGrants(role, held);
      for (const route of JOURNEY_ROUTES) {
        assert.equal(
          routeAllowed(route, { role, grants }),
          pageGuardAllows(route, role, held),
          `${route}: edge and page disagree for ${role} holding [${held.slice(0, 3).join(", ")}${held.length > 3 ? ", …" : ""}]`,
        );
      }
    }
  }
});

test("the journeys pages apply the route rule instead of the owner role", () => {
  const pages = [
    "src/app/(app)/journeys/page.tsx",
    "src/app/(app)/journeys/activity/page.tsx",
  ];
  for (const page of pages) {
    const code = shipped(page);
    assert.match(
      code,
      /await requireRoute\("\/journeys"\)/,
      `${page} must apply the same rule the edge applies`,
    );
    assert.doesNotMatch(
      code,
      /\brequireOwner\s*\(/,
      `${page} back on requireOwner() — journeys.manage would advertise a screen it then refuses`,
    );
  }
});

test("every journeys server action gates itself on journeys.manage", () => {
  // A Server Action compiles to a POST endpoint, so the page guard protects the
  // screen and nothing else: publishing a journey, archiving one, retrying a run
  // or firing a manual send are each reachable by a direct POST. Each has to ask
  // for itself, and ask FIRST — before any record is read or written.
  for (const file of ["src/app/actions/journeys.ts", "src/app/actions/journeyRuns.ts"]) {
    const code = shipped(file);
    assert.doesNotMatch(code, /\brequireOwner\s*\(/, `${file} still owner-gates a delegable surface`);

    const names = [...code.matchAll(/export async function (\w+)\(/g)].map((match) => match[1]);
    assert.ok(names.length >= 4, `expected the exported actions in ${file}, found ${names.length}`);
    for (const name of names) {
      const start = code.indexOf(`export async function ${name}(`);
      const end = code.indexOf("\nexport ", start + 1);
      const body = end === -1 ? code.slice(start) : code.slice(start, end);
      assert.match(
        body,
        /await requirePermission\("journeys\.manage"\)/,
        `${file}#${name} is a POST endpoint of its own — it must demand journeys.manage itself`,
      );
      assert.equal(
        /await\s+([A-Za-z_$][\w$]*)/.exec(body)?.[1],
        "requirePermission",
        `${file}#${name} does work before it authorises the caller`,
      );
    }
  }
});
