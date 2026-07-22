-- Multi-tenancy Phase B (inbox cluster). ADDITIVE + BEHAVIOUR-PRESERVING:
-- nullable tenantId + index on each table, backfilled to the founding Denago tenant.
-- Nothing reads it yet (no FK/NOT NULL/scoping). NOT NULL + FK + db.ts guard are
-- deferred to backup-first PRs (MULTITENANCY-SCOPING.md §3 Phase B/C). REPLAY-SAFE.

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "CannedReply" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

CREATE INDEX IF NOT EXISTS "Conversation_tenantId_idx" ON "Conversation"("tenantId");
CREATE INDEX IF NOT EXISTS "CannedReply_tenantId_idx" ON "CannedReply"("tenantId");

UPDATE "Conversation" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
UPDATE "CannedReply" SET "tenantId" = 'tenant_denago_cpt' WHERE "tenantId" IS NULL;
