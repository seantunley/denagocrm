import "server-only";
import { basePrisma } from "./db";
import { inheritedTenantId } from "./tenantWrite";

/**
 * WHICH WORKSPACE A BOT CONVERSATION BELONGS TO — one expression, one module.
 *
 * A bot conversation has two halves that must name the SAME workspace or the
 * feature comes apart:
 *
 *   - the RUNTIME half (webhook): claims the inbound provider event, loads and
 *     advances the BotSession, queues the reply, drains it;
 *   - the STAFF half (inbox): re-reads the queue for idempotency, takes the
 *     conversation over, hands it back, and flushes its own reply.
 *
 * Every one of those sites used to resolve `writeTenantId() ?? DEFAULT_TENANT_ID`.
 * `writeTenantId()` is null while enforcement is dormant — which is every
 * environment we run — so all of them collapsed onto the FOUNDING tenant. They
 * agreed, and they were wrong together; #473 stopped there deliberately, because
 * converting either half alone desynchronises the pair and strands the queue.
 *
 * This is the expression they now share, so they cannot desynchronise:
 *
 *   1. the ENFORCED scope (`writeTenantId()`), which also THROWS before any
 *      fallback when enforcement is on with no usable scope — fail closed;
 *   2. the AMBIENT scope. This is the rung that changed: `withChannelTenantScope`
 *      now binds the tenant that owns the provider ENDPOINT the event arrived on
 *      even while enforcement is dormant (as `withTelegramTenantScope` already
 *      did, and as `runCronPerTenant` already does for its dormant sweep), and
 *      the outbox drain binds each row's own tenant before draining it. So the
 *      runtime half has a real answer here, and so does the staff half once
 *      `withStaffConversationScope` has bound its acting workspace;
 *   3. the founding tenant — byte-for-byte today's single-tenant behaviour, and
 *      what an unmapped endpoint or a session with no workspace claim still gets.
 *
 * It is deliberately `inheritedTenantId(null)` and not a fourth ladder of its own:
 * rung 2 is the ambient rung that helper already documents, and a rule that exists
 * twice is a rule that gets fixed once.
 *
 * WHAT THIS CLOSES. `BotInboundEvent` deduplicates on
 * `("tenantId","channel","providerId")`. With every tenant's events claimed under
 * the founding tenant, two tenants whose customers produce the same provider id —
 * a Telegram `update_id` is per-bot, a Meta mid is per-page — collided, and the
 * second tenant's message was read as a redelivery of the first tenant's and
 * silently acked without ever being processed. A dropped customer message, with no
 * error anywhere.
 */
export function botConversationTenantId(): string {
  return inheritedTenantId(null);
}

/**
 * `withTenantWrite` for a bot-conversation write, resolving its owner through
 * {@link botConversationTenantId} instead of `writeTenantId() ?? DEFAULT_TENANT_ID`.
 *
 * Same transaction contract as `withTenantWrite`: one atomic transaction on the
 * trusted bypass client, every write inside MUST stamp `tenantId` explicitly, and
 * the children share the parent's tenant so the composite `(tenantId, parentId)`
 * FKs hold.
 */
export async function withBotConversationWrite<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (tx: any, tenantId: string) => Promise<T>,
): Promise<T> {
  const tenantId = botConversationTenantId();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (basePrisma as any).$transaction((tx: any) => fn(tx, tenantId));
}
