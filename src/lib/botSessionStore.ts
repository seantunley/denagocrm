import crypto from "crypto";
import { prisma } from "./db";
import type { TenantWriteTx } from "./tenantWrite";

export type StoredBotSession = {
  id: string;
  nodeId: string | null;
  vars: string;
  status: string;
  expiresAt: Date;
};

/** RLS scopes this read to the active tenant; the DB key includes tenantId. */
export async function loadBotSession(channel: string, key: string): Promise<StoredBotSession | null> {
  const row = await prisma.botSession.findFirst({ where: { channel, key } });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    await prisma.botSession.deleteMany({ where: { id: row.id } }).catch(() => {});
    return null;
  }
  return { id: row.id, nodeId: row.nodeId, vars: row.vars, status: row.status, expiresAt: row.expiresAt };
}

/**
 * Raw upsert because Prisma's generated schema still exposes the historic
 * `(channel,key)` compound selector while the database invariant is now the
 * correct `(tenantId,channel,key)`. Keeping the tenant explicit also makes this
 * safe on the trusted basePrisma transaction used by withTenantWrite().
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
    expiresAt: Date;
  },
): Promise<void> {
  await tx.$executeRawUnsafe(
    `INSERT INTO "BotSession"
       ("id", "tenantId", "channel", "key", "nodeId", "vars", "status", "updatedAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, $8)
     ON CONFLICT ("tenantId", "channel", "key") DO UPDATE
       SET "nodeId" = EXCLUDED."nodeId",
           "vars" = EXCLUDED."vars",
           "status" = EXCLUDED."status",
           "updatedAt" = CURRENT_TIMESTAMP,
           "expiresAt" = EXCLUDED."expiresAt"`,
    crypto.randomUUID(),
    tenantId,
    input.channel,
    input.key,
    input.nodeId,
    input.vars,
    input.status,
    input.expiresAt,
  );
}

export async function deleteBotSessionTx(
  tx: TenantWriteTx,
  tenantId: string,
  channel: string,
  key: string,
): Promise<void> {
  await tx.botSession.deleteMany({ where: { tenantId, channel, key } });
}
