import type { PermissionKey } from "./permissions";

/**
 * THE route → authorization table. ONE table, consulted by BOTH the edge proxy
 * and the page/action guards, so the two cannot disagree.
 *
 * It replaces src/lib/access.ts, which was a SECOND authorization system: a CSV
 * of "modules" on `User.modules`, carried as the `mods` JWT claim, that RBAC
 * never read and that never read RBAC. The concrete failure: an admin ticked a
 * permission for a role in /settings/access, `requirePermission` on the page
 * agreed — and the proxy still bounced the user to "/" because their `modules`
 * CSV lacked the flag. The admin saw the permission set, the user saw a redirect,
 * and nothing in the product explained the disagreement.
 *
 * The proxy runs at the edge on every request with only the JWT and no database
 * connection, so it cannot ask RBAC anything itself. Deleting the edge check was
 * not an option — these routes would then be unguarded until a page rendered.
 * So the grants are DERIVED FROM RBAC when the session is minted (see
 * `createSessionCookie` in auth.ts) and carried in the `rg` claim. The edge check
 * is a cache of an RBAC decision, never an independent authority.
 *
 * The cache cannot go stale: every write that changes what a user may do —
 * `updateRolePermissions`, `updateUserRoles` (accessControl.ts) and `setUserRole`
 * (security.ts) — bumps `User.sessionVersion` for the affected users, and
 * `getCurrentUser` rejects any session whose `sv` no longer matches. A permission
 * change therefore forces a fresh login, which re-derives `rg`.
 *
 * NOTE: "module" is an overloaded word here. `src/lib/modules/registry.ts` has an
 * unrelated ModuleId namespace (core/inbox/support/…) — that is the TENANT
 * feature pack (what a workspace has bought), not a per-user grant, and it stays.
 * Only the per-user CSV is retired.
 */

export type RouteRule =
  /**
   * PLATFORM-owner-only surface. No permission key in the catalogue describes
   * it, so the rule is exactly the `role === "owner"` predicate `requireOwner()`
   * applies — the role travels in the JWT already, so this is still one source
   * of truth.
   *
   * Reserve this for genuinely cross-tenant screens. A surface that shows one
   * workspace its OWN data wants `tenantOwner` instead: under `owner: true` the
   * provisioned owner of tenant B cannot reach their own screen, because
   * `role === "owner"` is a property of the platform, not of the workspace.
   */
  | { readonly prefix: string; readonly owner: true }
  /**
   * Reachable by the platform owner OR by the provisioned owner of the ACTIVE
   * tenant — the same predicate `requireTenantOwner()` applies.
   *
   * Unlike `owner`, this cannot be answered from the JWT role alone: tenant
   * ownership is a row (`Tenant.ownerUserId`), and the edge proxy has no
   * database. So it is resolved once at session mint, where the tenant is being
   * decided anyway, and carried in `rg` exactly like a permission-derived grant.
   * That keeps the edge a cache of an authoritative decision rather than a
   * second authority, and it inherits the same freshness guarantee: a session
   * outlives neither the RBAC nor the tenant membership it was minted from.
   */
  | { readonly prefix: string; readonly tenantOwner: true }
  /** Reachable by anyone holding ANY of these permissions. */
  | { readonly prefix: string; readonly anyOf: readonly PermissionKey[] };

export const ROUTE_RULES = [
  // Customer health scores every contact — the same grant the nav uses to show
  // the link, so a visible link can no longer lead to a redirect.
  { prefix: "/health", anyOf: ["contacts.view_all", "contacts.view_owned"] },
  // Fleet screens; fleets.* is what every fleet server action already requires.
  { prefix: "/fleets", anyOf: ["fleets.view", "fleets.manage"] },
  // Survey admin (distinct from the public /s response pages).
  { prefix: "/surveys", anyOf: ["surveys.view", "surveys.manage"] },
  // Journeys. `journeys.manage` is a real, grantable key in the catalogue and it
  // is what the sidebar already shows the link on — but the pages and actions
  // demanded requireOwner() and no rule gated the prefix at all. An admin could
  // grant the permission, the user would see "Journeys" in the nav, click it,
  // and land back on "/". The permission is the authority: journeys are
  // delegable workspace configuration, not platform administration.
  { prefix: "/journeys", anyOf: ["journeys.manage"] },
  // Owner-only: bot configuration reads integration secrets, /products manages
  // the catalogue, /trash reads every soft-deleted record through basePrisma
  // (which bypasses the RLS extension). Their pages call requireOwner()
  // themselves — this rule is the pre-filter, not the boundary.
  { prefix: "/chatbot", owner: true },
  { prefix: "/bot-builder", owner: true },
  { prefix: "/products", owner: true },
  { prefix: "/trash", owner: true },
  // Repairs — the workspace issue inbox. Restricted to the owner, and not for
  // want of a narrower key: every fix route it links to is owner-gated already
  // (/journeys calls requireOwner(), /settings/integration-overrides reads
  // credential configuration), so a rule that let anyone else in would show them
  // problems they cannot act on and Fix buttons that bounce them back to "/".
  // The page also reports across domains — journeys, integrations — which no
  // single permission in the catalogue describes.
  //
  // TENANT owner, not platform owner. Every row this page reads is stamped with
  // one tenant (`repairsTenantId()` scopes both the detector writes and the two
  // reads), so it is a workspace looking at its own broken things. Under
  // `owner: true` the only person who could ever look was the platform owner —
  // meaning tenant B's provisioned owner could not see tenant B's inbox, while
  // the platform owner saw whichever workspace their session happened to be
  // scoped to. Neither is the intent.
  { prefix: "/repairs", tenantOwner: true },
] as const satisfies readonly RouteRule[];

/** A prefix that appears in ROUTE_RULES — the only thing `requireRoute` accepts. */
export type GuardedRoute = (typeof ROUTE_RULES)[number]["prefix"];

/** The rule guarding `pathname`, or undefined when the route is not gated here. */
export function ruleFor(pathname: string): RouteRule | undefined {
  return ROUTE_RULES.find(
    (rule) => pathname === rule.prefix || pathname.startsWith(rule.prefix + "/"),
  );
}

export function parseGrants(csv: string | null | undefined): Set<string> {
  return new Set(
    (csv ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

/**
 * Derive the `rg` claim from a user's LIVE RBAC. Called at session mint only —
 * this is the one place a route grant is ever decided from permissions, so the
 * edge check and the page guard are answering the same question from the same
 * table.
 */
export function routeGrants(
  role: string,
  permissions: Iterable<string>,
  /**
   * Whether this user is the provisioned owner of the tenant the session is
   * being minted for. Defaults to FALSE, so a caller that has not resolved it
   * mints no tenant-owner grant rather than an unearned one.
   */
  opts?: { readonly tenantOwner?: boolean },
): string {
  if (role === "owner") return ROUTE_RULES.map((rule) => rule.prefix).join(",");
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  const tenantOwner = opts?.tenantOwner === true;
  return ROUTE_RULES.filter((rule) =>
    "anyOf" in rule
      ? rule.anyOf.some((key) => held.has(key))
      : "tenantOwner" in rule && tenantOwner,
  )
    .map((rule) => rule.prefix)
    .join(",");
}

/**
 * Edge decision. FAILS CLOSED: a token minted before the `rg` claim existed
 * carries no grants, so a non-owner is denied the gated routes until their next
 * sign-in rather than being waved through on an absent claim. A token minted
 * before `tenantOwner` rules existed fails closed the same way, for the same
 * reason — the grant is simply absent from its `rg`.
 *
 * `tenantOwner` rules are deliberately NOT a branch here. Tenant ownership is a
 * database row and the edge has no database, so the only honest thing it can do
 * is read the grant that the mint site — which did have the database — already
 * decided. That is the same lookup a permission-derived grant gets, so both go
 * down the same line below.
 */
export function routeAllowed(
  pathname: string,
  claims: { role: string; grants: string },
): boolean {
  const rule = ruleFor(pathname);
  if (!rule) return true;
  if (claims.role === "owner") return true;
  // Platform-owner-only: never minted for anyone else, so never openable.
  if ("owner" in rule) return false;
  return parseGrants(claims.grants).has(rule.prefix);
}
