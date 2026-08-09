import crypto from "crypto";
import { prisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId, type TenantWriteTx } from "./tenantWrite";
import type { BotOwnership } from "./botOwnership";

export type StoredBotSession = {
  id: string;
  nodeId: string | null;
  vars: string;
  status: string;
  ownership: BotOwnership;
  expiresAt: Date;
};

const OWNERSHIPS = new Set<BotOwnership>(["bot", "ai_handoff", "human", "delivery_failed"]);

/** A row written before this column existed, or by hand, is treated as bot-owned. */
function readOwnership(value: unknown): BotOwnership {
  return typeof value === "string" && OWNERSHIPS.has(value as BotOwnership) ? (value as BotOwnership) : "bot";
}

/**
 * Resolve the exact tenant namespace used by the write helper as well. Dormant /
 * trusted-system operation belongs to the founding tenant; enforcement with a
 * real tenant uses that tenant; a lost/null non-system scope fails closed inside
 * writeTenantId rather than choosing an arbitrary matching participant row.
 */
function sessionTenantId(): string {
  return writeTenantId() ?? DEFAULT_TENANT_ID;
}

/** Session identity is tenant + channel + participant, on reads and writes. */
export async function loadBotSession(channel: string, key: string): Promise<StoredBotSession | null> {
  const tenantId = sessionTenantId();
  const row = await prisma.botSession.findFirst({ where: { tenantId, channel, key } });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await prisma.botSession.deleteMany({ where: { id: row.id, tenantId } }).catch(() => {});
    return null;
  }
  return {
    id: row.id,
    nodeId: row.nodeId,
    vars: row.vars,
    status: row.status,
    ownership: readOwnership((row as { ownership?: unknown }).ownership),
    expiresAt: row.expiresAt,
  };
}

/**
 * Raw upsert because the database invariant is `(tenantId,channel,key)` and this
 * trusted transaction must keep the tenant explicit. This is also the exact key
 * used by loadBotSession above, so dormant, enforced and system paths agree.
 */
export async function upsertBotSessionTx(
  tx: TenantWriteTx,
  tenantId: string,
  input: {
    channel: string;
    key: string;
    nodeId: string | null;
    vars: string;
    status: string;
    ownership: BotOwnership;
    expiresAt: Date;
  },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "BotSession"
       ("id", "tenantId", "channel", "key", "nodeId", "vars", "status", "ownership", "updatedAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, $9)
     ON CONFLICT ("tenantId", "channel", "key") DO UPDATE
       SET "nodeId" = EXCLUDED."nodeId",
           "vars" = EXCLUDED."vars",
           "status" = EXCLUDED."status",
           "ownership" = EXCLUDED."ownership",
           "updatedAt" = CURRENT_TIMESTAMP,
           "expiresAt" = EXCLUDED."expiresAt"
       WHERE "BotSession"."ownership" <> 'human'`,
    crypto.randomUUID(),
    tenantId,
    input.channel,
    input.key,
    input.nodeId,
    input.vars,
    input.status,
    input.ownership,
    input.expiresAt,
  );
}

/**
 * Record that the last outbound message for this conversation definitively failed.
 *
 * Deliberately narrow: it changes ONLY ownership, never the node or the
 * variables, and it refuses to touch a conversation a person has taken over —
 * a failed bot message is not a reason to evict staff from a thread.
 */
export async function markBotSessionDeliveryFailedTx(
  tx: TenantWriteTx,
  tenantId: string,
  channel: string,
  key: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE "BotSession"
        SET "ownership" = 'delivery_failed', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "tenantId" = $1 AND "channel" = $2 AND "key" = $3 AND "ownership" <> 'human'`,
    tenantId,
    channel,
    key,
  );
}

/**
 * Pause a conversation without destroying its current graph position or captured
 * variables. This is intentionally a single UPSERT: a staff reply racing an
 * inbound webhook must not read state in JavaScript and then overwrite a newer
 * node/vars snapshot merely to change ownership.
 *
 * When no session exists yet we create a minimal paused row. When one exists we
 * change ONLY ownership/expiry and preserve the graph snapshot verbatim.
 */
export async function pauseBotSessionTx(
  tx: TenantWriteTx,
  tenantId: string,
  input: { channel: string; key: string; expiresAt: Date; ownership: BotOwnership },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "BotSession"
       ("id", "tenantId", "channel", "key", "nodeId", "vars", "status", "ownership", "updatedAt", "expiresAt")
     VALUES ($1, $2, $3, $4, NULL, '{}', 'paused', $5, CURRENT_TIMESTAMP, $6)
     ON CONFLICT ("tenantId", "channel", "key") DO UPDATE
       SET "status" = 'paused',
           "ownership" = EXCLUDED."ownership",
           "updatedAt" = CURRENT_TIMESTAMP,
           "expiresAt" = EXCLUDED."expiresAt"`,
    crypto.randomUUID(),
    tenantId,
    input.channel,
    input.key,
    input.ownership,
    input.expiresAt,
  );
}

/**
 * Clear a session the BOT finished with.
 *
 * Refuses a human-owned row. A turn can be in flight for seconds — `aiReply` is a
 * live model call — and staff can press Take over during it. Without this the
 * in-flight turn commits afterwards and silently returns the thread to the bot,
 * with the takeover already audited and the UI already showing "Human handling".
 * That is the same read-then-write race `pauseBotSessionTx` was written to avoid,
 * running in the other direction.
 */
export async function deleteBotSessionTx(
  tx: TenantWriteTx,
  tenantId: string,
  channel: string,
  key: string,
): Promise<void> {
  await tx.botSession.deleteMany({ where: { tenantId, channel, key, ownership: { not: "human" } } });
}

/**
 * Clear a session because a PERSON handed it back. This is the one path that may
 * discard human ownership, because a human is the one asking.
 */
export async function releaseBotSessionTx(
  tx: TenantWriteTx,
  tenantId: string,
  channel: string,
  key: string,
): Promise<void> {
  await tx.botSession.deleteMany({ where: { tenantId, channel, key } });
}
