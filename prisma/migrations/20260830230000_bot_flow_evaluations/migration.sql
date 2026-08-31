CREATE UNIQUE INDEX IF NOT EXISTS "BotFlow_tenantId_id_key"
  ON "BotFlow"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "BotFlowVersion_tenantId_id_key"
  ON "BotFlowVersion"("tenantId", "id");

CREATE TABLE IF NOT EXISTS "BotFlowEvaluation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "flowId" TEXT NOT NULL,
  "flowVersionId" TEXT,
  "name" TEXT NOT NULL,
  "turns" JSONB NOT NULL,
  "expectation" JSONB NOT NULL,
  "lastStatus" TEXT NOT NULL DEFAULT 'never_run',
  "lastResult" JSONB,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotFlowEvaluation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BotFlowEvaluation_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BotFlowEvaluation_tenant_flow_fkey"
    FOREIGN KEY ("tenantId", "flowId") REFERENCES "BotFlow"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "BotFlowEvaluation_tenant_flowVersion_fkey"
    FOREIGN KEY ("tenantId", "flowVersionId") REFERENCES "BotFlowVersion"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BotFlowEvaluation_name_check" CHECK (char_length("name") BETWEEN 1 AND 120),
  CONSTRAINT "BotFlowEvaluation_turns_check" CHECK (jsonb_typeof("turns") = 'array' AND jsonb_array_length("turns") <= 12),
  CONSTRAINT "BotFlowEvaluation_expectation_check" CHECK (jsonb_typeof("expectation") = 'object'),
  CONSTRAINT "BotFlowEvaluation_lastStatus_check" CHECK ("lastStatus" IN ('never_run', 'passed', 'failed', 'error'))
);

CREATE INDEX IF NOT EXISTS "BotFlowEvaluation_tenantId_flowId_createdAt_idx"
  ON "BotFlowEvaluation"("tenantId", "flowId", "createdAt");
CREATE INDEX IF NOT EXISTS "BotFlowEvaluation_tenantId_lastStatus_lastRunAt_idx"
  ON "BotFlowEvaluation"("tenantId", "lastStatus", "lastRunAt");

ALTER TABLE "BotFlowEvaluation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlowEvaluation_tenant_isolation" ON "BotFlowEvaluation";
CREATE POLICY "BotFlowEvaluation_tenant_isolation" ON "BotFlowEvaluation"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BotFlowEvaluation" FORCE ROW LEVEL SECURITY;
