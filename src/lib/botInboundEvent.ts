import crypto from "crypto";
import { withTenantWrite } from "./tenantWrite";

export type InboundBotEventClaim = { rowId: string | null };

/**
 * Atomically lease one provider-delivered inbound message/update before it can
 * drive the chatbot or create CRM side effects.
 *
 * `null` means the event is already completed or another invocation currently
 * owns an unexpired lease. `{ rowId: null }` means the provider supplied no stable
 * id; process it without a durable fence rather than dropping a real message.
 */
export async function claimInboundBotEvent(
  channel: string,
  providerId: string,
): Promise<InboundBotEventClaim | null> {
  const stableId = providerId.trim();
  if (!stableId) return { rowId: null };

  return withTenantWrite(async (tx, tenantId) => {
    const id = crypto.randomUUID();
    const rows = await tx.$queryRawUnsafe(
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
    ) as Array<{ id: string }>;
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
