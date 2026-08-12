/**
 * The acting-workspace rule, as a pure function so tests can execute it.
 *
 * No imports — `server-only` cannot be loaded under `node --test`, and every
 * previous attempt to test this area ended up regex-matching source instead of
 * running the decision.
 *
 * WHY THIS EXISTS. `currentScopeClass()` maps DORMANT enforcement to
 * `{ mode: "global" }`, and enforcement is dormant in every environment we run.
 * "Global" is the correct answer for a cron or a webhook, which have no session.
 * It is the WRONG answer for a staff member sitting in workspace B, and it is why:
 *
 *   - `withTenantWrite` stamped DEFAULT_TENANT_ID onto every actor's rows,
 *   - `resolveTenantMemberUser` skipped its TenantMember join,
 *   - `listTenantStaff` returned every user on the platform.
 *
 * All three are inert until enforcement is switched on — so the fix cannot wait
 * for the flip, because the wrong owners are being written now.
 */

export type ActingScope =
  | { mode: "global" }
  | { mode: "tenant"; tenantId: string }
  | { mode: "closed" };

/**
 * Decide the scope a USER-ORIGINATED operation acts in.
 *
 * Enforcement is authoritative when it is on: whatever the guard decided stands,
 * including `closed`. We never widen an enforced decision using a session.
 *
 * While dormant, a validated session workspace is the honest answer — that is the
 * workspace the person is actually working in. With no session (cron, webhook,
 * queue drain) the answer stays `global`, which is the pre-tenancy behaviour those
 * paths already rely on.
 */
export function decideActingScope(input: {
  enforcing: boolean;
  enforcedScope: ActingScope;
  sessionTenantId: string | null;
}): ActingScope {
  if (input.enforcing) return input.enforcedScope;
  const session = normalizeTenantId(input.sessionTenantId);
  return session ? { mode: "tenant", tenantId: session } : { mode: "global" };
}

/**
 * The tenantId to STAMP on a user-originated write through an unguarded client.
 *
 * `enforced ?? session ?? fallback` — the same ladder as the acting-tenant rule
 * reconciled in #464, deliberately so there is one rule and not a fifth copy.
 *
 * The fallback is only reached when there is no enforcement AND no session, i.e. a
 * background path. It is the founding tenant, which is right while exactly one
 * tenant exists and is the thing that must be revisited before a second one is
 * provisioned — a background write cannot guess an owner and must instead inherit
 * it from the record being acted on (`inheritedTenantId`).
 */
export function decideActingOwner(input: {
  enforcedTenantId: string | null;
  sessionTenantId: string | null;
  fallbackTenantId: string;
}): string {
  return (
    normalizeTenantId(input.enforcedTenantId) ??
    normalizeTenantId(input.sessionTenantId) ??
    input.fallbackTenantId
  );
}

/** Treat "", "   " and null alike — a blank claim is not a workspace. */
function normalizeTenantId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
