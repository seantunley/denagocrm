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
   * Owner-only surface. No permission key in the catalogue describes it, so the
   * rule is exactly the `role === "owner"` predicate `requireOwner()` applies —
   * the role travels in the JWT already, so this is still one source of truth.
   */
  | { readonly prefix: string; readonly owner: true }
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
export function routeGrants(role: string, permissions: Iterable<string>): string {
  if (role === "owner") return ROUTE_RULES.map((rule) => rule.prefix).join(",");
  const held = permissions instanceof Set ? permissions : new Set(permissions);
  return ROUTE_RULES.filter((rule) => "anyOf" in rule && rule.anyOf.some((key) => held.has(key)))
    .map((rule) => rule.prefix)
    .join(",");
}

/**
 * Edge decision. FAILS CLOSED: a token minted before the `rg` claim existed
 * carries no grants, so a non-owner is denied the gated routes until their next
 * sign-in rather than being waved through on an absent claim.
 */
export function routeAllowed(
  pathname: string,
  claims: { role: string; grants: string },
): boolean {
  const rule = ruleFor(pathname);
  if (!rule) return true;
  if (claims.role === "owner") return true;
  if ("owner" in rule) return false;
  return parseGrants(claims.grants).has(rule.prefix);
}
