import { DEFAULT_TENANT_ID } from "./tenant";

/**
 * Which tenant OWNS a row a person just created.
 *
 * `writeTenantId()` alone is the wrong answer and it fails in the worst
 * direction. It answers a different question — how an unguarded write should
 * behave during the enforcement rollout — and it returns null while enforcement
 * is DORMANT, which is today. So `writeTenantId() ?? DEFAULT_TENANT_ID` stamps
 * the FOUNDING tenant onto every user-originated write, whatever workspace the
 * person was acting in:
 *
 *     user in workspace B → creates a Quote → writeTenantId() is null
 *                        → falls back to DEFAULT_TENANT_ID
 *                        → the row belongs to workspace A
 *
 * That is worse than leaving the column NULL. A NULL row is visibly unowned and
 * can be backfilled; a row stamped with a confident, wrong owner looks correct
 * to every later query, appears in the wrong workspace, and is invisible to the
 * one that created it the moment enforcement flips on.
 *
 * `sessionTenantId` is `getActiveTenantId()` — the acting workspace, already
 * validated and already dropped when the claim went stale.
 *
 * Falling back to the founding tenant covers a session minted before the claim
 * existed, which is byte-for-byte today's single-tenant behaviour.
 *
 * Import-free so the rule is executed by a test rather than pattern-matched.
 * This is the same rule `decideBuilderTenant` applies to the Flow Builder; the
 * two exist separately only because that one shipped first, scoped to flows.
 */
export function decideActingTenant(input: {
  /** `writeTenantId()` — the enforced scope, or null while dormant. */
  enforcedTenantId: string | null;
  /** `getActiveTenantId()` — the session's validated active workspace. */
  sessionTenantId: string | null;
}): string {
  return input.enforcedTenantId ?? input.sessionTenantId ?? DEFAULT_TENANT_ID;
}
