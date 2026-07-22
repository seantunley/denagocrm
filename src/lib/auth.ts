import { cache } from "react";
import { cookies, headers } from "next/headers";
import crypto from "crypto";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { hasModule, type ModuleId } from "./access";
import { getUserSecurityState, getUserSecurityStateFresh } from "./userSecurity";
import { resolveActingTenant } from "./tenantContext";
import { tenantObserving } from "./tenantEnforcement";
import { honoredTenantClaim, isTenantForeignKeyViolation } from "./tenant";
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
  return user;
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

export async function requireAnyModule(...mods: ModuleId[]) {
  const user = await requireUser();
  if (user.role === "owner") return user;
  if (!mods.some((module) => hasModule(user, module))) redirect("/");
  return user;
}

export const requireCrm = () => requireAnyModule("crm");
export const requireWorkshop = () => requireAnyModule("workshop");
export const requireCrmOrWorkshop = () => requireAnyModule("crm", "workshop");
export const requireInbox = () => requireAnyModule("inbox");
export const requireOperational = () => requireAnyModule("crm", "workshop", "inbox");

export async function getIdleMinutes(): Promise<number> {
  const raw = await getSetting("SESSION_IDLE_MINUTES");
  const n = raw ? parseInt(raw, 10) : DEFAULT_IDLE_MINUTES;
  return isNaN(n) || n < 5 ? DEFAULT_IDLE_MINUTES : n;
}

export async function createSessionCookie(
  user: { id: string; name: string; email: string; role: string; modules: string },
  opts?: { pwa?: boolean }
) {
  // Fresh (uncached) read: this runs after a session-version bump in the same
  // request, so the memoised value would be stale and mint a cookie that logs
  // the user straight back out.
  const security = await getUserSecurityStateFresh(user.id);
  if (!security || security.disabledAt) throw new Error("User is disabled or no longer exists");
  const pwa = Boolean(opts?.pwa);
  // POLICY (see PWA_SESSION_HOURS in session.ts): the `pwa` opt-in makes BOTH the
  // idle timeout (here) and the absolute cap a week. `pwa` is client-supplied and
  // not proof of a trusted device, so this is an opt-in "keep me signed in for a
  // week" for any authenticated user; server-side revocation (sv + jti) is the
  // boundary. To keep a shorter inactivity window in this mode, use
  // getIdleMinutes() here and let only the absolute cap extend.
  const idle = pwa ? 7 * 24 * 60 : await getIdleMinutes();
  const jti = crypto.randomUUID();
  const h = await headers();
  // Multi-tenancy PLUMBING (behaviour-preserving): resolve the user's single
  // active tenant and record it on the session + JWT. Best-effort and fully
  // fail-open — if resolution errors, is ambiguous, or finds nothing, tenantId
  // stays null and login proceeds exactly as before. NOTHING reads/enforces this
  // yet; enforcement lands in a later, flag-gated PR.
  let tenantId: string | null = null;
  try {
    const ctx = await resolveActingTenant(user.id);
    if ("tenantId" in ctx) tenantId = ctx.tenantId;
    else if (tenantObserving()) {
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
  // Stamp the resolved tenant, but never let it block sign-in: if the tenant is
  // deleted between the resolve above and this insert (concurrent tenant admin),
  // the FK would reject the create — so on ANY failure retry once WITHOUT the
  // tenant. sessionTenantId tracks what actually landed so the JWT stays in sync.
  const sessionBase = {
    jti,
    userId: user.id,
    platform: pwa ? "pwa" : "web",
    ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
    userAgent: (h.get("user-agent") ?? "").slice(0, 250) || null,
  };
  let sessionTenantId = tenantId;
  try {
    await prisma.userSession.create({ data: { ...sessionBase, tenantId: sessionTenantId } });
  } catch (e) {
    // ONLY a broken tenant FK — the resolved tenant was deleted between the
    // resolve above and this insert — is recoverable by dropping the tenant and
    // retrying. Any other error is a real failure (e.g. a DB outage or a jti
    // collision) and must propagate, not be swallowed into a tenant-less session.
    if (!isTenantForeignKeyViolation(e, sessionTenantId)) throw e;
    sessionTenantId = null;
    await prisma.userSession.create({ data: sessionBase });
  }
  const token = await signFreshSession(
    { ...user, sessionVersion: security.sessionVersion },
    idle,
    { jti, pwa, ...(sessionTenantId ? { tid: sessionTenantId } : {}) }
  );
  const store = await cookies();
  store.set(SESSION_COOKIE, token, sessionCookieOptions(pwa));
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
