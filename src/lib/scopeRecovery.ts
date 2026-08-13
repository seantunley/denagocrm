import "server-only";
import { basePrisma } from "./db";
import { SESSION_COOKIE, verifySession } from "./session";
import { establishStaffTenantScope } from "./tenantScopeEntry";
import { getUserSecurityStateFresh } from "./userSecurity";
import type { TenantScope } from "./tenantScope";

/**
 * Re-derive the staff tenant scope from the session cookie, WITHOUT going through
 * `getCurrentUser()`.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * A tenant scope is established once, at the auth chokepoint, and every later
 * reader is supposed to find it on the ambient rung. Inside a SERVER ACTION there
 * is no rung to find it on:
 *
 *   - React `cache()` has no request store in an action, so #513's request-keyed
 *     holder — the carrier that makes a page render work — is never filled.
 *   - AsyncLocalStorage is therefore the only carrier left, and `enterWith` inside
 *     a callee does NOT reach the frame that called it. Measured on a production
 *     build (scripts/test-action-tenant-scope.ts): the chokepoint resolved
 *     `{"tenantId":"action_5580"}` and the caller read `ambient=null` on the very
 *     next line.
 *
 * So an action cannot rely on "somebody upstream established it". Each point of
 * use must be able to re-derive it, which is what this function is for.
 *
 * ── WHY IT IS SAFE ──────────────────────────────────────────────────────────
 *
 * It CANNOT WIDEN ANYTHING. Callers invoke it only when there is NO scope at all —
 * a state that is otherwise a hard refusal — so the alternatives are "the session's
 * own workspace" or "throw", never "a different workspace". An existing scope,
 * including a narrower or `system` one, is never consulted and never replaced.
 *
 * ── IT REVALIDATES THE SESSION IN FULL, AND IT MUST ────────────────────────
 *
 * The first version of this skipped the revocation, disabled-account and
 * session-version checks, arguing they were `getCurrentUser`'s job and had already
 * run for any request that got here. **That argument does not hold**, and review
 * caught it: this is called from the db.ts guard, which runs for EVERY tenant-scoped
 * query regardless of whether an auth guard ran first or ran at all — and
 * `withActingStaffScope` deliberately runs it BEFORE the action reaches its own
 * permission check. So the ordering it assumed is not merely unenforceable, it is
 * routinely false.
 *
 * Left as it was, a revoked device, a disabled account or a superseded session
 * (`sessionVersion` bumped by a password change) could still present its signed
 * cookie and have any query on a path with a missing or misordered guard promoted
 * into an authorised tenant query. That is the Prisma guard acting as an
 * alternative authentication path, which it must never be.
 *
 * So the same three checks `getCurrentUser` makes are made here, against
 * `basePrisma` and `getUserSecurityStateFresh`. Neither touches the memoised
 * `resolveCurrentUser` promise, so this still cannot re-enter it and deadlock the
 * way #518 did — the deadlock came from calling `getCurrentUser()` itself, not from
 * the checks it performs.
 *
 * This is not authorization. It re-derives WHICH WORKSPACE a still-valid session
 * acts in; permission checks remain entirely the callers' job.
 *
 * ── IT RETURNS THE SCOPE, NEVER A BOOLEAN ───────────────────────────────────
 *
 * `establishStaffTenantScope` answers `{ok: true, enterTenantId: null}` for the
 * owner escape hatch — success with NO scope, on purpose. So `ok` is true on a path
 * that established nothing, and #519 keyed its recovery on exactly that, reporting
 * success while leaving the scope absent. The caller needs the VALUE, both to know
 * whether anything was recovered and to bind it where it will actually be read.
 *
 * Null on anything unexpected, leaving the caller failing closed exactly as before.
 */
export async function recoverStaffScopeFromSession(): Promise<TenantScope | null> {
  try {
    const { cookies } = await import("next/headers");
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const session = await verifySession(token);
    if (!session) return null;

    // The session registry: a revoked device is locked out on its next request.
    // Mirrors getCurrentUser, including only checking when a `jti` is present —
    // sessions minted before the registry existed legitimately carry none, and
    // rejecting them here would sign those people out on a path that is only
    // supposed to re-derive a workspace.
    if (session.jti) {
      const row = await basePrisma.userSession.findUnique({
        where: { jti: session.jti },
        select: { revokedAt: true },
      });
      if (!row || row.revokedAt) return null;
    }

    // Disabled accounts and superseded sessions, same rule and same order as
    // getCurrentUser. `Fresh` (uncached) on purpose: the memoised variant is keyed
    // by React `cache()`, which has no request store in a Server Action — the exact
    // condition this function exists for — so caching would buy nothing and would
    // put a `cache()` call on the recovery path for no reason.
    const security = await getUserSecurityStateFresh(session.sub);
    if (!security || security.disabledAt) return null;
    if (security.sessionVersion !== session.sv) return null;

    const { ok, scope } = await establishStaffTenantScope(
      session.sub,
      session.tid ?? null,
      session.role === "owner",
    );
    return ok ? scope : null;
  } catch {
    // No request, no cookie store, a malformed token: all of them mean "no scope to
    // recover", which is the state we were already in.
    return null;
  }
}
