-- Phase C 2b-C3: inbound channel endpoint → tenant map. Additive, dormant.
-- One row per external endpoint WE own (WhatsApp phone-number id, Facebook Page id,
-- Instagram account id). Resolved before any tenant scope exists (resolveChannelTenant,
-- raw SQL) — scalar tenantId, no FK, active-tenant JOIN done in the resolver. Nothing
-- reads it until enforcement flips. Idempotent (IF NOT EXISTS) — safe to re-run.
CREATE TABLE IF NOT EXISTS "ChannelIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabledAt" TIMESTAMP(3),
    CONSTRAINT "ChannelIdentity_pkey" PRIMARY KEY ("id")
);

-- One endpoint belongs to exactly one tenant.
CREATE UNIQUE INDEX IF NOT EXISTS "ChannelIdentity_channel_externalId_key"
    ON "ChannelIdentity"("channel", "externalId");

CREATE INDEX IF NOT EXISTS "ChannelIdentity_tenantId_idx"
    ON "ChannelIdentity"("tenantId");
