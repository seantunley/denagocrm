import "server-only";
// main's imports, not this branch's: `legacyFlowTenant` was renamed to
// `flowTenantWhere` by #463 (the old name became a lie once the rule stopped
// being a legacy allowance), and the runtime tenant now comes from
// `botConversationTenantId` rather than `writeTenantId() ?? DEFAULT_TENANT_ID`,
// which resolved to the founding tenant while enforcement is dormant.
import { botConversationTenantId } from "./botTenant";
import { actingTenantId } from "./actingTenant";
import { flowTenantWhere } from "./flowTenantScope";

/**
 * The tenant a RUNTIME read is for — a webhook answering a customer.
 *
 * There is no session here, so the channel scope is all there is, and that is
 * correct: `resolveFlowSnapshot` is entered through `withChannelTenantScope`, which
 * resolves the tenant from the provider endpoint the message arrived on — and now
 * BINDS it while enforcement is dormant too, which is what makes this a real answer
 * rather than the founding tenant for everyone. Delegated to
 * {@link ../botTenant}.`botConversationTenantId` so the flow snapshot a turn runs is
 * chosen by the same workspace expression that claims its inbound event and queues
 * its reply: a turn must not answer with tenant A's published flow and file the
 * conversation under tenant B.
 */
export function runtimeFlowTenantId(): string {
  return botConversationTenantId();
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
 *
 * Now a thin alias over {@link ./actingTenant}.`actingTenantId`, which is the same
 * rule for the same reason and is what the non-flow session writers (dashboards,
 * test-drive bookings) call. Kept as a name because "the tenant a flow BUILDER
 * request is for" is the vocabulary the rest of this module reads in — but there
 * is exactly ONE implementation, so a fix to the rule cannot land in half of it.
 */
export async function builderTenantId(): Promise<string> {
  return actingTenantId();
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
