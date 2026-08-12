import { cache } from "react";
import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { prisma, basePrisma } from "./db";
import { getSetting } from "./settings";
import { getUserPermissions, usablePermissions } from "./permissionQuery";
import { routeGrants } from "./routeAccess";
import { getUserSecurityState, getUserSecurityStateFresh } from "./userSecurity";
import { resolveActingTenant } from "./tenantContext";
import { tenantObserving, tenantEnforcing, mayRetryTenantlessSession } from "./tenantEnforcement";
import { honoredTenantClaim, resolveLoginTenant } from "./tenant";
import { ensureFoundingMembership } from "./provisioning";
import { establishStaffTenantScope, validateInSystemScope } from "./tenantScopeEntry";
import { withTenant, withSystemScope } from "./tenantScope";
import {
  verifySession,
  signFreshSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  DEFAULT_IDLE_MINUTES,
} from "./session";

/**
 * Resolve the signed-in user for the current request. Wrapped in React
 * `cache()` so the session-registry, user and security-state lookups run once
 * per request even though the layout, nested layouts and page all call it.
 * The cache is request-scoped, so role/account/password changes still take
 * effect on the very next request.
 */
export const getCurrentUser = cache(async () => {
  // Phase C: session/account validation reads tenant-scoped infrastructure
  // (UserSession, security state) BEFORE the user's tenant is known. Run it in a
  // trusted `system` scope CONFINED to this callback, so (a) the guard doesn't
  // reject those reads (chicken-and-egg) and (b) an UNauthenticated request can't
  // leak a lingering system bypass — the scope reverts on every null path, and
  // only the user's OWN tenant scope (set after, below) persists on success.
  // DORMANT: bare fn() when off (no ALS overhead), system-scoped only when enforcing.
  const validated = await validateInSystemScope(async () => {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await verifySession(token);
    if (!session) return null;
    // Session registry: revoked devices are locked out on their next request.
    if (session.jti) {
      const row = await prisma.userSession.findUnique({
        where: { jti: session.jti },
        select: { revokedAt: true, lastActiveAt: true },
      });
      if (!row || row.revokedAt) return null;
      if (Date.now() - row.lastActiveAt.getTime() > 10 * 60 * 1000) {
        void prisma.userSession
          .update({ where: { jti: session.jti }, data: { lastActiveAt: new Date() } })
          .catch(() => {});
      }
    }

    // Governance: disabled accounts and stale session versions are rejected on
    // every request, so permission/role/password changes take effect immediately.
    const [user, security] = await Promise.all([
      prisma.user.findUnique({ where: { id: session.sub } }),
      getUserSecurityState(session.sub),
    ]);
    if (!user || !security || security.disabledAt) return null;
    if (security.sessionVersion !== session.sv) return null;
    return { user, tid: session.tid ?? null };
  });
  if (!validated) return null;
  // Establish the user's OWN tenant for the rest of the request. DORMANT — a no-op
  // that always succeeds until enforcing. Under enforcement it FAILS CLOSED here
  // (returns null → session unusable) when no valid acting tenant resolves — a
  // stale/tenant-less/ambiguous session must not pass requireUser/role/owner checks
  // or reach global models. Resolves inline (no getCurrentUser re-entry); runs once
  // per request (getCurrentUser is cache()d).
  const established = await establishStaffTenantScope(
    validated.user.id,
    validated.tid,
    validated.user.role === "owner",
  );
  if (!established.ok) return null;
  return validated.user;
});

export async function requireUser() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * API-route authentication. Unlike requireUser (which redirects to /login — an
 * HTML response wrong for API clients), these throw an ApiAuthError so the route
 * can return a proper JSON 401/403. They run the SAME fresh DB checks as
 * getCurrentUser (device/session revocation, disabled account, session version),
 * so an API route must never assume "the proxy already authenticated this".
 */
export class ApiAuthError extends Error {
  constructor(public status: 401 | 403) {
    super(status === 403 ? "Forbidden" : "Unauthorized");
  }
}

export async function requireApiUser() {
  const user = await getCurrentUser();
  if (!user) throw new ApiAuthError(401);
  return user;
}

export async function requireApiOwner() {
  const user = await requireApiUser();
  if (user.role !== "owner") throw new ApiAuthError(403);
  return user;
}

/** Turn an ApiAuthError into its JSON response; returns null for anything else. */
export function apiAuthErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ApiAuthError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return null;
}

export async function requireOwner() {
  const user = await requireUser();
  if (user.role !== "owner") redirect("/");
  return user;
}

/**
 * Require that the caller is either the global platform owner OR the
 * provisioned owner of their active tenant (the earliest-joined TenantMember,
 * which is always the account createTenant() set up and then disabled until
 * activation). Use this in pages and actions that are tenant-specific but not
 * platform-global — a tenant owner must be able to manage their own integration
 * credentials without needing the global owner role.
 */
export async function requireTenantOwner() {
  const user = await requireUser();
  if (user.role === "owner") return user;
  const tenantId = await getActiveTenantId();
  if (!tenantId) redirect("/");
  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { ownerUserId: true },
  });
  if (tenant?.ownerUserId !== user.id) redirect("/");
  return user;
}

export async function getIdleMinutes(): Promise<number> {
  const raw = await getSetting("SESSION_IDLE_MINUTES");
  const n = raw ? parseInt(raw, 10) : DEFAULT_IDLE_MINUTES;
  return isNaN(n) || n < 5 ? DEFAULT_IDLE_MINUTES : n;
}

export async function createSessionCookie(
  user: { id: string; name: string; email: string; role: string },
  opts?: { pwa?: boolean; sessionVersion?: number }
) {
  // Fresh (uncached) read: this runs after a session-version bump in the same
  // request, so the memoised value would be stale and mint a cookie that logs
  // the user straight back out.
  const security = await getUserSecurityStateFresh(user.id);
  if (!security || security.disabledAt) throw new Error("User is disabled or no longer exists");

  // WHICH version the replacement cookie asserts.
  //
  // The fresh read answers "whatever the row says right now", which is correct
  // at login and wrong immediately after a security change. The losing sequence:
  //
  //   1. the security action commits, bumping the version to 5;
  //   2. an owner resets the password or revokes every session, bumping it to 6
  //      and killing every live cookie, including this user's;
  //   3. this call reads 6 and mints a brand-new valid cookie at 6.
  //
  // Step 3 restores exactly the access step 2 removed, and the older request
  // beats the newer revocation. A caller that has just bumped the version knows
  // the number its own transaction produced and passes it, so a revocation
  // landing afterwards leaves this cookie stale — which is the point of a
  // revoke-all. Callers with nothing to pin (login) keep the fresh read.
  const sessionVersion = opts?.sessionVersion ?? security.sessionVersion;
  const pwa = Boolean(opts?.pwa);
  const jti = crypto.randomUUID();
  const h = await headers();

  // Multi-tenancy: resolve the user's single active tenant FIRST — it's recorded
  // on the session + JWT, and (under enforcement) it scopes the tenant-owned
  // setting read + session write below, which run BEFORE any request chokepoint
  // has established a scope. Best-effort + fail-open when NOT enforcing: on error/
  // ambiguity/none, tenantId stays null and login proceeds exactly as before.
  let tenantId: string | null = null;
  try {
    // Owner lockout-proofing (DORMANT off): under enforcement, guarantee the global
    // owner is a member of the always-active founding tenant BEFORE resolving, so the
    // resolveLoginTenant owner fallback below lands on a REAL, active membership.
    // Idempotent (upsert). Uses basePrisma deliberately: no tenant scope is
    // established at this point in login and TenantMember is a tenant-scoped model, so
    // the guarded client would fail closed here — basePrisma is the bootstrap path
    // every other provisioning caller uses. Skipped entirely when not enforcing.
    if (tenantEnforcing() && user.role === "owner") {
      await ensureFoundingMembership(basePrisma, user.id);
    }
    const ctx = await resolveActingTenant(user.id);
    // Pure, unit-tested decision: the resolved tenant, or — under enforcement — the
    // owner's founding-tenant fallback, or null. When NOT enforcing this is null on
    // the error branch for every role, so login is byte-for-byte the pre-tenancy path.
    tenantId = resolveLoginTenant(ctx, user.role, tenantEnforcing());
    if (!tenantId && "error" in ctx && tenantObserving()) {
      // MONITOR: surface logins that couldn't resolve a single active tenant —
      // exactly the ones that would be affected once enforcement is turned on.
      // These are EXPECTED observations, not system errors, so they go to the
      // server log (Vercel) — NOT logError, which files a System-Log row and
      // fires/throttles system_error push alerts (would page admins and mute a
      // real alert for 30 min during a monitor rollout).
      console.warn(`[tenant-monitor] login: no single active tenant for user ${user.id} (${ctx.error})`);
    }
  } catch (e) {
    // never let tenant resolution block sign-in
    if (tenantObserving()) console.warn(`[tenant-monitor] login tenant resolve failed for user ${user.id}:`, e);
  }
  // Under enforcement a session with no resolvable single tenant CANNOT be issued:
  // the tenant-owned setting/session writes below would fail closed, and a
  // tenant-less session couldn't act anyway. Reject cleanly (fail closed) rather
  // than deadlock. When NOT enforcing this never triggers (unchanged behaviour).
  if (tenantEnforcing() && !tenantId) {
    throw new Error("Cannot issue a session: no single active tenant for this user");
  }

  // Run the tenant-owned setting read + session write inside the resolved tenant's
  // scope (RELIABLE via runInTenantScope, not enterWith) so the guard doesn't
  // reject them once enforcement is on. When off, the scope is inert and this is
  // exactly the pre-tenancy path.
  await withTenant(tenantId, async () => {
    // POLICY (see PWA_SESSION_HOURS in session.ts): the `pwa` opt-in makes BOTH
    // the idle timeout and the absolute cap a week. `pwa` is client-supplied and
    // not proof of a trusted device; server-side revocation (sv + jti) is the
    // boundary.
    const idle = pwa ? 7 * 24 * 60 : await getIdleMinutes();
    const sessionBase = {
      jti,
      userId: user.id,
      platform: pwa ? "pwa" : "web",
      ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
      userAgent: (h.get("user-agent") ?? "").slice(0, 250) || null,
    };
    // Stamp the resolved tenant. If the tenant is deleted between resolve and
    // insert (concurrent tenant admin) the FK breaks. When NOT enforcing, fall back
    // to a tenant-less session for backward compatibility (in a system scope so the
    // guard doesn't re-stamp the invalid tenant). When ENFORCING, do NOT issue a
    // tenant-less session — propagate the error and abort login (mayRetryTenantlessSession).
    let sessionTenantId = tenantId;
    try {
      await prisma.userSession.create({ data: { ...sessionBase, tenantId: sessionTenantId } });
    } catch (e) {
      if (!mayRetryTenantlessSession(e, sessionTenantId)) throw e;
      sessionTenantId = null;
      await withSystemScope(() => prisma.userSession.create({ data: sessionBase }));
    }
    // THE MINT SITE for the proxy's route-grant claim. `rg` is DERIVED from RBAC
    // here and nowhere else — it is a cache of a decision this database read just
    // made, not a second authority. (Before this, the proxy read a hand-ticked
    // `User.modules` CSV that RBAC never wrote: an admin could grant a permission
    // in /settings/access, the page guard would allow the screen, and the edge
    // would still redirect the user to "/".)
    //
    // Computed INSIDE withTenant so the tenant-scoped RBAC read resolves against
    // the tenant this session is being issued for.
    //
    // Freshness is not best-effort: updateRolePermissions and updateUserRoles
    // (accessControl.ts) and setUserRole (security.ts) all bump
    // User.sessionVersion for the affected users, and getCurrentUser refuses any
    // session whose `sv` no longer matches — so a permission change invalidates
    // every token carrying a now-stale `rg` and the next sign-in re-derives it.
    //
    // Tenant ownership is the one input `rg` needs that RBAC does not hold: it
    // is a row (Tenant.ownerUserId), and the edge proxy has no database, so it
    // has to be decided here or not at all. Read against sessionTenantId — the
    // tenant this session is actually stamped with — not the resolved `tenantId`
    // above, which the tenantless-session fallback may have just dropped.
    //
    // basePrisma deliberately, exactly as requireTenantOwner() does: Tenant is a
    // tenant-scoped model, so the guarded client would fail closed reading the
    // very row that decides the scope.
    //
    // Best-effort, and it FAILS CLOSED: any error mints no tenant-owner grant,
    // costing that owner the gated screens until their next sign-in. Failing the
    // login instead would lock a whole workspace out of the CRM over a page —
    // and requireRoute re-resolves this live on every request anyway, so the
    // grant is a cache, never the boundary.
    let tenantOwner = false;
    if (sessionTenantId && user.role !== "owner") {
      try {
        const tenant = await basePrisma.tenant.findUnique({
          where: { id: sessionTenantId },
          select: { ownerUserId: true },
        });
        tenantOwner = tenant?.ownerUserId === user.id;
      } catch (e) {
        if (tenantObserving()) {
          console.warn(`[tenant-monitor] tenant-owner grant resolve failed for user ${user.id}:`, e);
        }
      }
    }
    const grants = routeGrants(
      user.role,
      usablePermissions(await getUserPermissions(user.id)),
      { tenantOwner },
    );
    const token = await signFreshSession(
      { ...user, grants, sessionVersion },
      idle,
      { jti, pwa, ...(sessionTenantId ? { tid: sessionTenantId } : {}) }
    );
    const store = await cookies();
    store.set(SESSION_COOKIE, token, sessionCookieOptions(pwa));
  });
}

export async function destroySessionCookie() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * The active tenant carried by the current session's JWT (the `tid` claim), or
 * null. READ-ONLY plumbing for multi-tenancy: it exposes the claim so later,
 * flag-gated enforcement can consume it. It intentionally enforces nothing and
 * returns null for older sessions minted before the claim existed — callers must
 * not gate access on it yet.
 *
 * The claim is honoured ONLY when it is safe to trust:
 *  - the session is fully valid — getCurrentUser applies the same device
 *    revocation, disabled-account and session-version checks, so a signature that
 *    verifies but belongs to a revoked/disabled/superseded session yields null;
 *  - it still resolves to the user's SOLE active tenant (see honoredTenantClaim):
 *    a `tid` that went stale after a membership removal or tenant suspension is
 *    dropped, and so is one that became AMBIGUOUS because a second active
 *    membership was added after login.
 */
export async function getActiveTenantId(): Promise<string | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await verifySession(token);
  const sole = await resolveActingTenant(user.id);
  return honoredTenantClaim(session?.tid ?? null, sole);
}

/**
 * {@link getActiveTenantId}, but "there is no request at all" answers `null`
 * instead of throwing.
 *
 * `cookies()` throws outside a request, which is a fact about the CALLER, not
 * about the tenant: a cron tick, a queue drain or a script has no session to
 * read, and that is simply "no session", not a failure to determine one. Every
 * user-originated resolver needs this distinction, and each was making it
 * separately — `actingScopeClass` had a private copy while `actingTenantId`
 * had none at all, so the same absent session produced `global` through one
 * and an unhandled Next.js error through the other.
 *
 * Catch ONLY Next's documented missing-request error. A real failure while a
 * request DOES exist — session resolution, malformed state, a database error —
 * still propagates: silently turning those into "no tenant" would widen access
 * at the exact moment the tenant decision became uncertain.
 */
export async function getActiveTenantIdIfRequest(): Promise<string | null> {
  try {
    return await getActiveTenantId();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("next-dynamic-api-wrong-context") ||
        error.message.includes("outside a request scope"))
    ) {
      return null;
    }
    throw error;
  }
}
