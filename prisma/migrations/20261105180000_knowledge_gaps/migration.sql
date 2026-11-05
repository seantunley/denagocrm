-- AI knowledge improvement (2026-11-05): questions the chatbot couldn't answer, grouped, for the owner to draft answers
-- from. Additive only; re-runnable.
CREATE TABLE IF NOT EXISTS "KnowledgeGap" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "examples" JSONB NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 1,
  "intent" TEXT,
  "firstAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAskedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'open',
  "draftEntryId" TEXT,
  "claimedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeGap_pkey" PRIMARY KEY ("id")
);
-- For a database that already ran an earlier copy of this migration (a preview branch).
ALTER TABLE "KnowledgeGap" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeGap_tenantId_key_key" ON "KnowledgeGap"("tenantId", "key");
CREATE INDEX IF NOT EXISTS "KnowledgeGap_tenantId_status_lastAskedAt_idx" ON "KnowledgeGap"("tenantId", "status", "lastAskedAt");

ALTER TABLE "KnowledgeGap" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "KnowledgeGap_tenant_isolation" ON "KnowledgeGap";
CREATE POLICY "KnowledgeGap_tenant_isolation" ON "KnowledgeGap"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "KnowledgeGap" FORCE ROW LEVEL SECURITY;
