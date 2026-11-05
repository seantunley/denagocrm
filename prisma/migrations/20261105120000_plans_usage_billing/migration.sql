-- Plans, usage metering and platform invoices (Sean, 2026-11-05). Additive only; re-runnable.
-- Nothing changes for any workspace until a platform admin sets a plan or turns on platformAi.

ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "planName" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "planMonthlyCents" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "planIncluded" JSONB;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "planOverage" JSONB;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "platformAi" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "UsageCounter" (
  "tenantId" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "meter" TEXT NOT NULL,
  "count" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("tenantId", "month", "meter")
);

CREATE TABLE IF NOT EXISTS "TenantInvoice" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "number" SERIAL NOT NULL,
  "period" TEXT NOT NULL,
  "lines" JSONB NOT NULL,
  "subtotalCents" INTEGER NOT NULL,
  "vatRatePct" DOUBLE PRECISION NOT NULL,
  "vatCents" INTEGER NOT NULL,
  "totalCents" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'issued',
  "fromText" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "voidedAt" TIMESTAMP(3),
  "createdBy" TEXT,
  CONSTRAINT "TenantInvoice_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TenantInvoice_number_key" ON "TenantInvoice"("number");
CREATE INDEX IF NOT EXISTS "TenantInvoice_tenantId_period_idx" ON "TenantInvoice"("tenantId", "period");

-- Same isolation as every table since the RLS cutover: a workspace reads only its own counters and
-- invoices; the platform console and the meter write through basePrisma (bypass). Without the policy
-- the tables fail closed in production.
ALTER TABLE "UsageCounter" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "UsageCounter_tenant_isolation" ON "UsageCounter";
CREATE POLICY "UsageCounter_tenant_isolation" ON "UsageCounter"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "UsageCounter" FORCE ROW LEVEL SECURITY;

ALTER TABLE "TenantInvoice" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantInvoice_tenant_isolation" ON "TenantInvoice";
CREATE POLICY "TenantInvoice_tenant_isolation" ON "TenantInvoice"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantInvoice" FORCE ROW LEVEL SECURITY;
