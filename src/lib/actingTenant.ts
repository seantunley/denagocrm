import "server-only";
import { writeTenantId } from "./tenantWrite";
import { getActiveTenantIdIfRequest } from "./auth";
import { currentTenantScope } from "./tenantScope";
import { decideBuilderTenant } from "./flowTenantScope";
import { TenantScopeError } from "./tenantGuard";

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
 * WHEN NEITHER RUNG RESOLVES, THIS REFUSES. It used to fall back to the founding
 * tenant, on the reasoning that this covered a session minted before the claim
 * existed and was byte-for-byte the single-tenant behaviour. That was true right
 * up until there were two tenants: the same fallback then files a second
 * workspace's record under the first, which is precisely the "confident, wrong
 * owner" this comment warns about four lines above.
 *
 * ORDER — enforced scope, then an explicitly BOUND ambient workspace, then
 * the session's workspace, then a refusal.
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
  const enforcedTenantId = writeTenantId();
  // AN EXPLICITLY BOUND WORKSPACE COUNTS, IN BOTH MODES.
  //
  // `writeTenantId()` is null while enforcement is dormant even when an ambient
  // scope IS bound, so this used to ignore a workspace that had been established
  // deliberately. That was invisible while the last rung silently answered "the
  // founding tenant" and there was only one; the moment the fallback became a
  // refusal, `enqueueStaffReplyInWorkspace` — which runs inside the scope
  // `withStaffConversationScope` binds — started throwing with the workspace
  // sitting right there in the ambient store. The two-tenant harness caught it.
  //
  // Ranked above the session deliberately: a bound scope is the more specific
  // statement. The webhook binds the workspace that owns the provider endpoint,
  // and the inbox binds the one the person is signed into; in both cases the
  // work belongs to the bound workspace, not to whatever the session resolves.
  const ambientTenantId = currentTenantScope()?.tenantId ?? null;
  const sessionTenantId = ambientTenantId ?? (await getActiveTenantIdIfRequest());
  // THE FOUNDING-TENANT FALLBACK IS NOW UNREACHABLE, deliberately.
  //
  // `decideBuilderTenant` ends `?? DEFAULT_TENANT_ID`, and that last rung is
  // reached only when enforcement gives nothing AND the session resolves
  // nothing. The doc above already says what that means: a session minted
  // before the `tid` claim existed, one gone stale after a membership changed,
  // or one that is AMBIGUOUS because the person holds two or more active
  // memberships. It is not "a background path" — this function is documented as
  // NOT FOR BACKGROUND WORK, and those callers use `inheritedTenantId` instead.
  //
  // Taking the founding tenant there is the failure this file's own comment
  // describes as the worse direction: the row looks correctly owned, appears in
  // the wrong workspace, and nothing flags it. That was invisible while one
  // workspace existed and the guess was always right. With a second one it is a
  // record filed under another business.
  //
  // The pure rule is left exactly as it is — it is shared, separately tested,
  // and still correct for the two rungs above. This refuses before the last one
  // can be taken.
  if (!enforcedTenantId && !sessionTenantId) {
    throw new TenantScopeError(
      "No workspace is attached to this sign-in, so there is nobody to own this record. " +
        "Sign out and back in; if you belong to more than one workspace, sign in to the one you mean to work in.",
    );
  }
  return decideBuilderTenant({ enforcedTenantId, sessionTenantId });
}
