import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTenantWrite } from "./tenantWrite";

export type InboundBotEventClaim = { rowId: string | null };

type InboundBotEventContext = { eventId: string | null };
const inboundEventContext = new AsyncLocalStorage<InboundBotEventContext>();

/**
 * Run the event's application work with the durable provider-event row id in
 * async context. CRM action nodes can use this stable id without plumbing a
 * provider-specific message id through every channel adapter and flow API.
 */
export async function withInboundBotEvent<T>(
  claim: InboundBotEventClaim,
  fn: () => Promise<T>,
): Promise<T> {
  return inboundEventContext.run({ eventId: claim.rowId }, fn);
}

/** Stable across provider retries; null for untracked/test/manual flow runs. */
export function currentInboundBotEventId(): string | null {
  return inboundEventContext.getStore()?.eventId ?? null;
}

/**
 * Atomically lease one provider-delivered inbound message/update before it can
 * drive the chatbot or create CRM side effects.
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

/** Mark the leased event complete only after all critical webhook work succeeded. */
export async function completeInboundBotEvent(claim: InboundBotEventClaim): Promise<void> {
  if (!claim.rowId) return;
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: claim.rowId, tenantId, status: "running" },
      data: { status: "completed", completedAt: new Date(), leaseUntil: null, lastError: null },
    });
  });
}

/** Release a failed event immediately so the provider's retry can reclaim it. */
export async function retryInboundBotEvent(
  claim: InboundBotEventClaim,
  error: unknown,
): Promise<void> {
  if (!claim.rowId) return;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await withTenantWrite(async (tx, tenantId) => {
    await tx.botInboundEvent.updateMany({
      where: { id: claim.rowId, tenantId, status: "running" },
      data: { status: "retry", leaseUntil: null, lastError: message },
    });
  });
}
