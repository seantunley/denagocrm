import "server-only";
import { basePrisma } from "./db";
import type { ChannelKind } from "./channelTenant";

/**
 * CLAIM ONE INBOUND ENDPOINT FOR ONE WORKSPACE — ATOMICALLY (reviews of #1181 / #1182, 2026-11-21).
 *
 * "Read whether it's free, then write it" let two workspaces connecting the same account at once both read "free",
 * and the second write moved the account to itself. Here the database decides, and the first claimant wins:
 *   1. CREATE the row: the (channel, externalId) unique key lets exactly one concurrent creator succeed.
 *   2. It exists: take it only if it is ALREADY this workspace's, or RETIRED (disabledAt set). An active row of
 *      another workspace is never rewritten. Postgres re-checks that WHERE on the locked row, so two workspaces racing
 *      for a retired row can't both win.
 * Returns false when another workspace holds it: the caller refuses, and stores no credential.
 */
export async function claimChannelEndpoint(tenantId: string, channel: ChannelKind, externalId: string, label: string | null): Promise<boolean> {
  try {
    await basePrisma.channelIdentity.create({ data: { tenantId, channel, externalId, label } });
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code !== "P2002") throw error;
  }
  const { count } = await basePrisma.channelIdentity.updateMany({
    where: { channel, externalId, OR: [{ tenantId }, { disabledAt: { not: null } }] },
    data: { tenantId, disabledAt: null, ...(label !== null ? { label } : {}) },
  });
  return count === 1;
}
