-- Plan terms by month (review of #1002: an old month was invoiced at today's prices). Additive only; re-runnable.
-- One row per workspace per month a plan was saved in; an invoice uses the latest row at or before its month.

CREATE TABLE IF NOT EXISTS "TenantPlanTerms" (
  "tenantId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "planName" TEXT,
  "monthlyCents" INTEGER,
  "included" JSONB NOT NULL,
  "overage" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "updatedBy" TEXT,
  CONSTRAINT "TenantPlanTerms_pkey" PRIMARY KEY ("tenantId", "month")
);

-- Same isolation as UsageCounter and TenantInvoice: the console writes through basePrisma (bypass).
ALTER TABLE "TenantPlanTerms" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantPlanTerms_tenant_isolation" ON "TenantPlanTerms";
CREATE POLICY "TenantPlanTerms_tenant_isolation" ON "TenantPlanTerms"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantPlanTerms" FORCE ROW LEVEL SECURITY;
