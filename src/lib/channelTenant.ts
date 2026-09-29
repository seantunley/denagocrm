import "server-only";
import { basePrisma } from "./db";

/**
 * Inbound-channel → tenant resolution (Phase C 2b-C3).
 *
 * A webhook (WhatsApp / Meta Messenger / Instagram) carries no staff session, so
 * under enforcement it must resolve WHICH tenant an inbound event belongs to from a
 * stable discriminator of OUR endpoint (not the sender) — the WhatsApp business
 * phone-number id, the Facebook Page id, the Instagram account id — mapped by
 * `ChannelIdentity`. This lookup runs BEFORE any tenant scope exists, so it uses raw
 * SQL through `basePrisma` (the guard would otherwise demand a scope) — the same
 * pre-scope infra boundary as `resolveApiKeyTenant` and the token resolvers.
 *
 * Like the API-key resolver, it JOINs `Tenant` and requires `active = true` (and
 * `ChannelIdentity.disabledAt IS NULL`): a mapping to a suspended tenant, a disabled
 * endpoint, or a deleted tenant (no `Tenant` row) must NOT resolve. Returns the
 * owning `tenantId`, or null to fail closed.
 */
export type ChannelKind = "whatsapp" | "messenger" | "instagram" | "x";

export async function resolveChannelTenant(
  channel: ChannelKind,
  externalId: string | null | undefined,
): Promise<string | null> {
  if (!externalId) return null;
  const rows = await basePrisma.$queryRaw<{ tenantId: string }[]>`
    SELECT c."tenantId"
    FROM "ChannelIdentity" c
    JOIN "Tenant" t ON t."id" = c."tenantId"
    WHERE c."channel" = ${channel} AND c."externalId" = ${externalId}
      AND c."disabledAt" IS NULL AND t."active" = true
    LIMIT 1`;
  return rows[0]?.tenantId ?? null;
}
