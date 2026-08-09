import crypto from "crypto";
import { prisma } from "./db";
import { DEFAULT_TENANT_ID } from "./tenant";
import { writeTenantId, type TenantWriteTx } from "./tenantWrite";

export type StoredBotSession = {
  id: string;
  nodeId: string | null;
  vars: string;
  status: string;
  expiresAt: Date;
};

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
  return { id: row.id, nodeId: row.nodeId, vars: row.vars, status: row.status, expiresAt: row.expiresAt };
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
