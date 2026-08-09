import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { withTenantWrite } from "./tenantWrite";

export type InboundBotEventClaim = { rowId: string | null };

/**
 * Four outcomes rather than a nullable claim. `completed` and `leased` both mean
 * "do not process this now", but they need OPPOSITE answers to the provider: a
 * completed event is genuinely finished and must be acked, while a leased one is
 * owned by an attempt that may already have died. Acking a leased event retires
 * the provider's redelivery and loses the message permanently, because nothing
 * sweeps a lease that expires with no one waiting on it.
 *
 * `unidentified` is a provider event with no stable id. actionKey() below returns
 * null for it, which silently disables the slot marker, the lead externalId and
 * the activity marker together — so an unfenced event books twice on redelivery.
 * It is refused rather than run without the guarantees the rest of this PR adds.
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
): Promise<InboundBotEventOutcome> {
  const stableId = providerId.trim();
  if (!stableId) return { status: "unidentified" };

  return withTenantWrite(async (tx, tenantId): Promise<InboundBotEventOutcome> => {
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
    if (rows[0]) return { status: "claimed", claim: { rowId: rows[0].id } };

    // No row means one of two opposite things. Ask which, so the caller can ack a
    // finished event but let a live lease be redelivered.
    const settled = await tx.$queryRawUnsafe(
      `SELECT "status" FROM "BotInboundEvent"
        WHERE "tenantId" = $1 AND "channel" = $2 AND "providerId" = $3`,
      tenantId,
      channel,
      stableId,
    ) as Array<{ status: string }>;
    // A row that vanished between the two statements is treated as leased: asking
    // for a redelivery is recoverable, acking a message we never ran is not.
    return settled[0]?.status === "completed" ? { status: "completed" } : { status: "leased" };
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
