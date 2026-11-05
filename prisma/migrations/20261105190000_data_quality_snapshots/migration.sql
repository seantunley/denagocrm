-- Data Quality Centre (2026-11-05): one snapshot per workspace per day, for the trend. Additive only; re-runnable.
CREATE TABLE IF NOT EXISTS "DataQualitySnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "contactScore" INTEGER NOT NULL,
  "dealScore" INTEGER NOT NULL,
  "counts" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DataQualitySnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DataQualitySnapshot_tenantId_day_key" ON "DataQualitySnapshot"("tenantId", "day");

ALTER TABLE "DataQualitySnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DataQualitySnapshot_tenant_isolation" ON "DataQualitySnapshot";
CREATE POLICY "DataQualitySnapshot_tenant_isolation" ON "DataQualitySnapshot"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "DataQualitySnapshot" FORCE ROW LEVEL SECURITY;
