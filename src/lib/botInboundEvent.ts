import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTenantWrite } from "./tenantWrite";

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

type InboundBotEventContext = { eventId: string | null };
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
  return inboundEventContext.run({ eventId: claim.rowId }, fn);
}

/** Stable across provider retries; null for simulator/manual/untracked runs. */
export function currentInboundBotEventId(): string | null {
  return inboundEventContext.getStore()?.eventId ?? null;
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

  return withTenantWrite(async (tx, tenantId): Promise<InboundBotEventOutcome> => {
    const id = crypto.randomUUID();
    // `withTenantWrite` still hands back a deliberately broad `any` tx (see the
    // note on its contract), so the row shape is stated as an annotation rather
    // than a type argument an untyped call cannot accept.
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

/** Mark this exact lease complete only after all critical webhook work succeeded. */
export async function completeInboundBotEvent(claim: InboundBotEventClaim): Promise<void> {
  const rowId = claim.rowId;
  const leaseAttempt = claim.leaseAttempt;
  if (!rowId || leaseAttempt == null) return;
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running", attempts: leaseAttempt },
      data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
    });
  });
}

/** Release only this exact failed lease so the provider retry can reclaim it. */
export async function retryInboundBotEvent(
  claim: InboundBotEventClaim,
  error: unknown,
): Promise<void> {
  const rowId = claim.rowId;
  const leaseAttempt = claim.leaseAttempt;
  if (!rowId || leaseAttempt == null) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running", attempts: leaseAttempt },
      data: { status: "retry", leaseUntil: null, lastError: message },
    });
  });
}
