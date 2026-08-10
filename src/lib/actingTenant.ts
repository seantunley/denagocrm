import "server-only";
import { writeTenantId } from "./tenantWrite";
import { getActiveTenantId } from "./auth";
import { decideBuilderTenant } from "./flowTenantScope";

/**
 * The workspace the CURRENT SESSION is acting as, for stamping a record the user
 * is creating right now — a dashboard, a test-drive booking, a bot flow.
 *
 * WHY THIS EXISTS. `writeTenantId()` returns null while enforcement is DORMANT,
 * and enforcement is dormant in every environment today. So every server action
 * that stamped a create from it — or that left the stamp to the db.ts guard,
 * which is the same thing, because `scopeArgs` returns its args untouched unless
 * `tenantEnforcing()` — has been writing `tenantId: null`. Those rows become
 * invisible the moment enforcement flips, to the workspace that created them and
 * to the person looking at one right now.
 *
 * `getActiveTenantId()` is the resolver built for this question: it validates the
 * session (device revocation, disabled account, session version) and honours the
 * `tid` claim only while it still resolves to the user's sole active membership,
 * so a claim that went stale after a removal, suspension or a second membership
 * is dropped.
 *
 * ORDER — enforced scope, then the session's workspace, then the founding tenant.
 * See {@link ./flowTenantScope}.`decideBuilderTenant`, which is the pure rule and
 * is shared verbatim: resolving from `writeTenantId()` alone was the original
 * defect in the flow-builder scoping work, because dormant is today and every
 * request would collapse onto the founding tenant no matter which workspace the
 * session was acting as. This module exists so the second, third and fourth
 * caller of that rule do not each re-derive it slightly differently.
 *
 * The RUNTIME counterpart — a webhook, a cron, a scheduled step, anything with no
 * session — is `inheritedTenantId()` in ./tenantWrite, which asks the record being
 * acted on instead. Never use this one from a background path: there is no
 * session there, so it would silently answer "the founding tenant".
 */
export async function actingTenantId(): Promise<string> {
  return decideBuilderTenant({
    enforcedTenantId: writeTenantId(),
    sessionTenantId: await getActiveTenantId(),
  });
}
