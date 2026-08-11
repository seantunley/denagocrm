import "server-only";
import { writeTenantId } from "./tenantWrite";
import { getActiveTenantId } from "./auth";
import { decideBuilderTenant } from "./flowTenantScope";

/**
 * The workspace the CURRENT STAFF SESSION is acting as, for stamping a row that
 * person is creating right now — a quote, a job-card line, a pipeline, a
 * dashboard, a test-drive booking, a bot flow.
 *
 * WHY THIS EXISTS. `writeTenantId()` returns null while enforcement is DORMANT,
 * and enforcement is dormant in every environment today. So every server action
 * that stamped a create from it — or that left the stamp to the db.ts guard,
 * which is the same thing, because `scopeArgs` returns its args untouched unless
 * `tenantEnforcing()` — has been writing `tenantId: null`. Those rows become
 * invisible the moment enforcement flips, to the workspace that created them and
 * to the person looking at one right now.
 *
 * And `writeTenantId() ?? DEFAULT_TENANT_ID`, the obvious repair, fails in the
 * worse direction:
 *
 *     user in workspace B → creates a Quote → writeTenantId() is null
 *                        → falls back to DEFAULT_TENANT_ID
 *                        → the row belongs to workspace A
 *
 * A NULL row is visibly unowned and can be backfilled. A row stamped with a
 * confident, wrong owner looks correct to every later query, appears in the wrong
 * workspace, and is invisible to the one that created it at the flip.
 *
 * `getActiveTenantId()` is the resolver built for this question: it validates the
 * session (device revocation, disabled account, session version) and honours the
 * `tid` claim only while it still resolves to the user's sole active membership,
 * so a claim that went stale after a removal or a suspension is dropped, and so is
 * one that became ambiguous when a second active membership was added after login.
 * Falling back to the founding tenant covers a session minted before the claim
 * existed, which is byte-for-byte today's single-tenant behaviour.
 *
 * ORDER — enforced scope, then the session's workspace, then the founding tenant.
 * The rule itself is {@link ./flowTenantScope}.`decideBuilderTenant`, which is
 * pure and is executed by `tests/flowBuilderTenantScope.test.ts` rather than
 * pattern-matched. THERE IS EXACTLY ONE COPY OF IT, deliberately: resolving from
 * `writeTenantId()` alone was the original defect in the flow-builder scoping
 * work, and a rule that exists twice is a rule that gets fixed once. This module
 * exists so the second, third and fourth caller do not each re-derive it slightly
 * differently. (The name still says "builder" because that was the first caller;
 * moving the rule to a neutrally-named module is a follow-up worth doing, and a
 * rename is all it is.)
 *
 * Throws (fail closed) when enforcement is ON with no usable scope, because
 * `writeTenantId()` throws `TenantScopeError` before this ladder is reached — so
 * the fallbacks below can never paper over a missed chokepoint.
 *
 * NOT FOR BACKGROUND WORK — cron, webhooks, queue drains, scheduled journey
 * steps. There is no session there, so this would silently answer "the founding
 * tenant". Those paths ask the record they are acting on instead: see
 * `inheritedTenantId()` in ./tenantWrite. A customer-facing portal request is the
 * same case — the viewer is a Contact, not a staff member — and must resolve the
 * owner from the Contact.
 */
export async function actingTenantId(): Promise<string> {
  return decideBuilderTenant({
    enforcedTenantId: writeTenantId(),
    sessionTenantId: await getActiveTenantId(),
  });
}
