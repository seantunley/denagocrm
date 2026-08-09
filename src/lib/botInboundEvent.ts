import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTenantWrite } from "./tenantWrite";

export type InboundBotEventClaim = { rowId: string | null };

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
 */
export async function claimInboundBotEvent(
  channel: string,
  providerId: string,
): Promise<InboundBotEventClaim | null> {
  const stableId = providerId.trim();
  if (!stableId) return { rowId: null };

  return withTenantWrite(async (tx, tenantId) => {
    const id = crypto.randomUUID();
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
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
       RETURNING "id"`,
      id,
      tenantId,
      channel,
      stableId,
    );
    return rows[0] ? { rowId: rows[0].id } : null;
  });
}

/** Mark the lease complete only after all critical webhook work succeeded. */
export async function completeInboundBotEvent(claim: InboundBotEventClaim): Promise<void> {
  const rowId = claim.rowId;
  if (!rowId) return;
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running" },
      data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
    });
  });
}

/** Release a failed event immediately so the provider retry can reclaim it. */
export async function retryInboundBotEvent(
  claim: InboundBotEventClaim,
  error: unknown,
): Promise<void> {
  const rowId = claim.rowId;
  if (!rowId) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: rowId, tenantId, status: "running" },
      data: { status: "retry", leaseUntil: null, lastError: message },
    });
  });
}
