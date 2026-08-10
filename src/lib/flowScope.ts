import "server-only";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId } from "./tenantWrite";
import { getActiveTenantId } from "./auth";
import { decideBuilderTenant, flowTenantWhere } from "./flowTenantScope";

/**
 * The tenant a RUNTIME read is for — a webhook answering a customer.
 *
 * There is no session here, so the channel scope (or the founding tenant while
 * enforcement is dormant) is all there is, and that is correct: `resolveFlowSnapshot`
 * is entered through `withChannelTenantScope`, which already resolved the tenant
 * from the provider endpoint the message arrived on.
 */
export function runtimeFlowTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/**
 * The tenant a STAFF BUILDER request is for.
 *
 * `writeTenantId()` alone is wrong here and was the whole defect in the first
 * version of this change. It answers a different question — how an unguarded
 * write should behave during the enforcement rollout — and it returns null while
 * enforcement is DORMANT, which is today. Every builder request therefore
 * collapsed to the founding tenant no matter which workspace the session was
 * acting as, so the scoping "fix" scoped everything to tenant A and a second
 * workspace's owner still listed, opened and saved tenant A's flows.
 *
 * The session's active workspace is the thing that knows. `getActiveTenantId()`
 * is the resolver built for exactly this: it validates the session (device
 * revocation, disabled account, session version), and honours the `tid` claim
 * only while it still resolves to the user's sole active membership — so a claim
 * that went stale after a removal, suspension or a second membership is dropped.
 *
 * Order: an enforced scope wins (and `writeTenantId()` still throws, failing
 * closed, when enforcement is on with no usable scope); then the session's
 * workspace; then the founding tenant, which is what a session minted before the
 * claim existed resolves to — byte-for-byte today's single-tenant behaviour.
 */
export async function builderTenantId(): Promise<string> {
  return decideBuilderTenant({
    enforcedTenantId: writeTenantId(),
    sessionTenantId: await getActiveTenantId(),
  });
}

/**
 * `where` fragment scoping a BotFlow query to the tenant of the current BUILDER
 * request.
 *
 * The runtime resolver has scoped its reads since #402; the builder never did.
 * Every editor surface addressed a flow by bare `id`, and
 * `findUnique({ where: { id } })` cannot be narrowed by the db.ts guard even once
 * enforcement is on, because `id` is already the unique selector. So a second
 * workspace's owner holding a flow id could read and rewrite another tenant's
 * live conversation graph, before and after the flip.
 *
 * Spread this into a `findFirst`/`updateMany`/`deleteMany` — never `findUnique`,
 * `update` or `delete`, which take a unique selector and cannot carry the tenant
 * predicate with it.
 */
export async function flowScope(): Promise<ReturnType<typeof flowTenantWhere>> {
  return flowTenantWhere(await builderTenantId());
}

/**
 * `where` fragment scoping a Journey query to the current builder's workspace.
 *
 * Every BotFlow query being scoped still left this boundary open: the canvas
 * Journey picker, the allow-list the AI drafter may use, and — the one that
 * matters — the publication validator all read `journey.findMany({ status:
 * "active" })` across every tenant. So a second workspace saw the founding
 * tenant's Journey names, and a flow naming one of them PUBLISHED cleanly,
 * because another tenant's active Journey satisfied the check.
 *
 * Journey.tenantId is nullable for the same reason BotFlow's is, so it takes the
 * same rule — which is now strict equality for every tenant, the founding one
 * included. See flowTenantScope.ts.
 */
export async function journeyScope(): Promise<ReturnType<typeof flowTenantWhere>> {
  return flowTenantWhere(await builderTenantId());
}
