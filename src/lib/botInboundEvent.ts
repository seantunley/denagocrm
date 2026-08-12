import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withBotConversationWrite } from "./botTenant";
import { type TenantWriteTx } from "./tenantWrite";

export type InboundBotEventClaim = { rowId: string | null; leaseAttempt: number | null };

/**
 * Four outcomes rather than a nullable claim. `completed` and `leased` both mean
 * "do not process this now", but they need OPPOSITE answers to the provider: a
 * completed event is genuinely finished and must be acked, while a leased one is
 * owned by an attempt that may already have died. Acking a leased event retires
 * the provider's redelivery and loses the message permanently, because nothing
 * sweeps a lease that expires with no one waiting on it.
 *
 * `unidentified` is a provider event carrying no stable id. Nothing downstream can
 * derive a retry-safe action key from it (see botActionKey), so every CRM effect it
 * performed would duplicate on redelivery. It is refused rather than run without
 * idempotency.
 */
export type InboundBotEventOutcome =
  | { status: "claimed"; claim: InboundBotEventClaim }
  | { status: "completed" }
  | { status: "leased" }
  | { status: "unidentified" };

/** Thrown so the route answers non-2xx and the provider redelivers once the lease expires. */
export class InboundBotEventLeasedError extends Error {
  constructor(channel: string, providerId: string) {
    super(`Inbound ${channel} event ${providerId} is leased by another attempt — asking the provider to redeliver`);
    this.name = "InboundBotEventLeasedError";
  }
}

type InboundBotEventContext = { claim: InboundBotEventClaim };
const inboundEventContext = new AsyncLocalStorage<InboundBotEventContext>();

/**
 * Run one provider event's application work with its durable ledger row id in
 * async context. CRM action nodes can derive a retry-stable effect identity
 * without plumbing provider-specific message ids through every flow API.
 */
export async function withInboundBotEvent<T>(
  claim: InboundBotEventClaim,
  fn: () => Promise<T>,
): Promise<T> {
  return inboundEventContext.run({ claim }, fn);
}

/** Stable across provider retries; null for simulator/manual/untracked runs. */
export function currentInboundBotEventId(): string | null {
  return inboundEventContext.getStore()?.claim.rowId ?? null;
}

/**
 * Atomically lease one provider-delivered inbound message/update. A completed
 * event is never reclaimed; a crashed/failed lease becomes claimable again.
 * `attempts` doubles as the lease generation so an expired worker cannot later
 * complete or release a newer worker's reclaimed lease.
 */
export async function claimInboundBotEvent(
  channel: string,
  providerId: string,
): Promise<InboundBotEventOutcome> {
  const stableId = providerId.trim();
  if (!stableId) return { status: "unidentified" };

  // THE DEDUPE KEY'S TENANT, AND WHY IT IS NOT `withTenantWrite` ANY MORE.
  //
  // This is the row that FIRST hears about a provider event, so there is no record
  // to inherit from; the honest owner is the tenant that owns the ENDPOINT the event
  // arrived on. `withChannelTenantScope` resolves exactly that, and now BINDS it
  // while enforcement is dormant as well as under it, so
  // `botConversationTenantId()` picks it up from the ambient rung.
  //
  // It matters here more than anywhere else in the bot stack, because the tenant is
  // half of a UNIQUENESS constraint rather than merely an owner column: the upsert
  // below conflicts on `("tenantId","channel","providerId")`. While every tenant's
  // events were claimed under the founding tenant, two tenants whose customers
  // produced the same provider id — a Telegram `update_id` is per-bot, a Meta mid is
  // per-page, neither is global — collided on that key. The second tenant's genuine
  // customer message matched the first tenant's completed row, was read as a
  // redelivery, and was acked without ever being processed. No error, no retry, no
  // trace: the message simply never existed as far as that workspace was concerned.
  return withBotConversationWrite(async (tx, tenantId): Promise<InboundBotEventOutcome> => {
    const id = crypto.randomUUID();
    // `withBotConversationWrite` still hands back a deliberately broad `any` tx
    // (see the note on its contract), so the row shape is stated as an annotation
    // rather than a type argument an untyped call cannot accept.
    const rows: Array<{ id: string; attempts: number }> = await tx.$queryRawUnsafe(
      `INSERT INTO "BotInboundEvent"
         ("id", "tenantId", "channel", "providerId", "status", "attempts", "leaseUntil", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, 'running', 1, NOW() + INTERVAL '5 minutes', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT ("tenantId", "channel", "providerId") DO UPDATE
         SET "status" = 'running',
             "attempts" = "BotInboundEvent"."attempts" + 1,
             "leaseUntil" = NOW() + INTERVAL '5 minutes',
             "lastError" = NULL,
             "updatedAt" = NOW()
       WHERE "BotInboundEvent"."status" <> 'completed'
         AND ("BotInboundEvent"."leaseUntil" IS NULL OR "BotInboundEvent"."leaseUntil" < NOW())
       RETURNING "id", "attempts"`,
      id,
      tenantId,
      channel,
      stableId,
    );
    // The claim carries the lease generation, so only THIS attempt can later
    // complete or release it.
    if (rows[0]) return { status: "claimed", claim: { rowId: rows[0].id, leaseAttempt: rows[0].attempts } };

    // No row means one of two opposite things. Ask which, so the caller can ack a
    // finished event but let a live lease be redelivered.
    const settled: Array<{ status: string }> = await tx.$queryRawUnsafe(
      `SELECT "status" FROM "BotInboundEvent"
        WHERE "tenantId" = $1 AND "channel" = $2 AND "providerId" = $3`,
      tenantId,
      channel,
      stableId,
    );
    // A row that vanished between the two statements is treated as leased: asking
    // for a redelivery is recoverable, acking a message we never ran is not.
    return settled[0]?.status === "completed" ? { status: "completed" } : { status: "leased" };
  });
}

/** The full claim for the event being processed, so it can be settled in-transaction. */
export function currentInboundBotClaim(): InboundBotEventClaim | null {
  return inboundEventContext.getStore()?.claim ?? null;
}

/**
 * Settle the lease INSIDE the caller's transaction.
 *
 * Completing the event only after the flow transaction had already committed left
 * a window that corrupts conversation STATE rather than merely duplicating an
 * effect. The session and outbox commit; the process dies; the lease expires; the
 * provider redelivers. The flow then loads an ALREADY-ADVANCED session and reads
 * the old message as the answer to the NEXT question — the phone number the
 * customer sent becomes their answer to "what service do you need?". CRM action
 * idempotency cannot help, because the damage is in the graph position.
 *
 * Committed alongside the session and the outbox, the turn and its
 * acknowledgement are all-or-nothing. The webhook still calls the non-transaction
 * variant afterwards for paths that never opened one (a suppressed turn, a
 * non-flow reply); it is fenced by the same generation, so it is a no-op once
 * this has run.
 */
export async function completeInboundBotEventTx(
  tx: TenantWriteTx,
  tenantId: string,
  claim: InboundBotEventClaim | null,
): Promise<void> {
  const rowId = claim?.rowId;
  const leaseAttempt = claim?.leaseAttempt;
  if (!rowId || leaseAttempt == null) return;
  await tx.botInboundEvent.updateMany({
    // Same generation fence the other two settle paths use: only the attempt that
    // took this lease may complete it.
    where: { id: rowId, tenantId, status: "running", attempts: leaseAttempt },
    data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
  });
}

/**
 * Mark this exact lease complete only after all critical webhook work succeeded.
 *
 * RUNTIME — {@link botConversationTenantId}, the same expression the claim above
 * used, because `tenantId` here is a FILTER on the row that claim wrote. The two
 * must name the same workspace or a completed event is never marked complete and
 * the provider redelivers it for ever.
 */
export async function completeInboundBotEvent(claim: InboundBotEventClaim): Promise<void> {
  const rowId = claim.rowId;
  const leaseAttempt = claim.leaseAttempt;
  if (!rowId || leaseAttempt == null) return;
  await withBotConversationWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running", attempts: leaseAttempt },
      data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
    });
  });
}

/**
 * Release only this exact failed lease so the provider retry can reclaim it.
 *
 * RUNTIME — {@link botConversationTenantId}; see {@link completeInboundBotEvent}
 * for why the settle paths must resolve exactly what the claim resolved.
 */
export async function retryInboundBotEvent(
  claim: InboundBotEventClaim,
  error: unknown,
): Promise<void> {
  const rowId = claim.rowId;
  const leaseAttempt = claim.leaseAttempt;
  if (!rowId || leaseAttempt == null) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withBotConversationWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running", attempts: leaseAttempt },
      data: { status: "retry", leaseUntil: null, lastError: message },
    });
  });
}
