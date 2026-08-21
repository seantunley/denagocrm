CREATE TABLE IF NOT EXISTS "OfflineMutationReceipt" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "OfflineMutationReceipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OfflineMutationReceipt_tenantId_createdAt_idx"
  ON "OfflineMutationReceipt"("tenantId", "createdAt");
CREATE INDEX IF NOT EXISTS "OfflineMutationReceipt_userId_createdAt_idx"
  ON "OfflineMutationReceipt"("userId", "createdAt");

ALTER TABLE "OfflineMutationReceipt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OfflineMutationReceipt" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "OfflineMutationReceipt_tenant_isolation" ON "OfflineMutationReceipt";
CREATE POLICY "OfflineMutationReceipt_tenant_isolation" ON "OfflineMutationReceipt"
  USING ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''))
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.tenant_id', true), ''));
