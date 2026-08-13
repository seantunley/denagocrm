import "server-only";
import { SESSION_COOKIE, verifySession } from "./session";
import { establishStaffTenantScope } from "./tenantScopeEntry";
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
 * The signed JWT is the source for `sub`, `tid` and `role`, verified here, so none
 * is caller-supplied. Revocation, disabled-account and session-version checks are
 * deliberately NOT repeated: they are `getCurrentUser`'s job, they have already run
 * for any authenticated request that reached this point, and re-running them would
 * re-enter that memoised promise and deadlock (#518). This only RECOVERS a scope the
 * same validated session already earned — `establishStaffTenantScope` still resolves
 * the membership itself and still refuses when there is none.
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
