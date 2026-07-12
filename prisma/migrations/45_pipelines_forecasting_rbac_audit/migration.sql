-- Additive professional CRM governance layer.
-- Existing owner/member roles and PipelineStage/Lead relations remain operational.

CREATE TABLE "SalesPipeline" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "type" TEXT NOT NULL DEFAULT 'sales',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "SalesPipeline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SalesPipeline_name_key" ON "SalesPipeline"("name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "SalesPipeline_single_default_key" ON "SalesPipeline"("isDefault") WHERE "isDefault" = true AND "deletedAt" IS NULL;

INSERT INTO "SalesPipeline" ("id", "name", "description", "type", "active", "isDefault")
VALUES ('pipeline_default_retail', 'Retail Sales', 'Default retail cart sales pipeline', 'retail', true, true)
ON CONFLICT DO NOTHING;

ALTER TABLE "PipelineStage" ADD COLUMN "pipelineId" TEXT;
ALTER TABLE "PipelineStage" ADD COLUMN "defaultProbability" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "PipelineStage" ADD COLUMN "staleAfterDays" INTEGER;
ALTER TABLE "PipelineStage" ADD COLUMN "isClosed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PipelineStage" ADD COLUMN "closedStatus" TEXT;

UPDATE "PipelineStage" SET "pipelineId" = 'pipeline_default_retail' WHERE "pipelineId" IS NULL;
ALTER TABLE "PipelineStage" ALTER COLUMN "pipelineId" SET NOT NULL;
ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId")
  REFERENCES "SalesPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_probability_check" CHECK ("defaultProbability" BETWEEN 0 AND 100);
ALTER TABLE "PipelineStage"
  ADD CONSTRAINT "PipelineStage_closed_status_check" CHECK ("closedStatus" IS NULL OR "closedStatus" IN ('won','lost'));
DROP INDEX IF EXISTS "PipelineStage_order_key";
CREATE UNIQUE INDEX "PipelineStage_pipelineId_order_key" ON "PipelineStage"("pipelineId", "order");
CREATE INDEX "PipelineStage_pipelineId_idx" ON "PipelineStage"("pipelineId");

CREATE TABLE "Team" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "managerId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name") WHERE "deletedAt" IS NULL;
ALTER TABLE "Team" ADD CONSTRAINT "Team_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TeamMember" (
  "id" TEXT NOT NULL,
  "teamId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "isManager" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");
CREATE INDEX "TeamMember_userId_idx" ON "TeamMember"("userId");
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Role" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "system" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

CREATE TABLE "Permission" (
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  CONSTRAINT "Permission_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "RolePermission" (
  "roleId" TEXT NOT NULL,
  "permissionKey" TEXT NOT NULL,
  CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId", "permissionKey")
);
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "Permission"("key") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserRole" (
  "userId" TEXT NOT NULL,
  "roleId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId", "roleId")
);
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Role" ("id", "name", "description", "system") VALUES
  ('role_crm_admin', 'CRM administrator', 'Full CRM administration excluding infrastructure secrets', true),
  ('role_sales_manager', 'Sales manager', 'Manage teams, pipelines, forecasts and all sales records', true),
  ('role_sales_rep', 'Sales representative', 'Manage assigned and team sales records', true),
  ('role_marketing', 'Marketing user', 'Manage campaigns, journeys and marketing audiences', true),
  ('role_workshop_manager', 'Workshop manager', 'Manage workshop operations', true),
  ('role_technician', 'Technician', 'Work assigned workshop jobs', true),
  ('role_auditor', 'Read-only auditor', 'Read reports, forecasts and immutable audit history', true)
ON CONFLICT DO NOTHING;

INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('pipelines.view', 'View sales pipelines', 'Sales'),
  ('pipelines.manage', 'Create and configure sales pipelines and stages', 'Sales'),
  ('forecast.view', 'View sales forecasts', 'Sales'),
  ('forecast.manage', 'Update forecast categories, probabilities and close dates', 'Sales'),
  ('leads.view_all', 'View all leads', 'CRM'),
  ('leads.view_owned', 'View owned and team leads', 'CRM'),
  ('leads.create', 'Create leads', 'CRM'),
  ('leads.edit', 'Edit lead details', 'CRM'),
  ('leads.assign', 'Assign leads to users and teams', 'CRM'),
  ('leads.change_stage', 'Move leads between stages in the same pipeline', 'CRM'),
  ('leads.change_pipeline', 'Move leads to a different sales pipeline', 'CRM'),
  ('leads.mark_won', 'Mark leads won', 'CRM'),
  ('leads.mark_lost', 'Mark leads lost', 'CRM'),
  ('leads.reopen', 'Reopen won or lost leads', 'CRM'),
  ('leads.link_contact', 'Link or change the customer on a lead', 'CRM'),
  ('leads.delete', 'Move leads to Trash', 'CRM'),
  ('teams.view', 'View teams', 'Administration'),
  ('teams.manage', 'Create teams and manage membership', 'Administration'),
  ('roles.view', 'View roles and permissions', 'Administration'),
  ('roles.manage', 'Manage role permissions and user roles', 'Administration'),
  ('audit.view', 'View audit events', 'Governance'),
  ('audit.export', 'Export audit events', 'Governance'),
  ('campaigns.manage', 'Manage campaigns', 'Marketing'),
  ('journeys.manage', 'Manage marketing journeys', 'Marketing'),
  ('workshop.manage', 'Manage workshop operations', 'Workshop'),
  ('reports.view', 'View reports', 'Reporting')
ON CONFLICT DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT 'role_crm_admin', "key" FROM "Permission" ON CONFLICT DO NOTHING;

INSERT INTO "RolePermission" ("roleId", "permissionKey") VALUES
  ('role_sales_manager', 'pipelines.view'), ('role_sales_manager', 'pipelines.manage'),
  ('role_sales_manager', 'forecast.view'), ('role_sales_manager', 'forecast.manage'),
  ('role_sales_manager', 'leads.view_all'), ('role_sales_manager', 'leads.create'),
  ('role_sales_manager', 'leads.edit'), ('role_sales_manager', 'leads.assign'),
  ('role_sales_manager', 'leads.change_stage'), ('role_sales_manager', 'leads.change_pipeline'),
  ('role_sales_manager', 'leads.mark_won'), ('role_sales_manager', 'leads.mark_lost'),
  ('role_sales_manager', 'leads.reopen'), ('role_sales_manager', 'leads.link_contact'),
  ('role_sales_manager', 'leads.delete'), ('role_sales_manager', 'teams.view'),
  ('role_sales_manager', 'teams.manage'), ('role_sales_manager', 'roles.view'),
  ('role_sales_manager', 'reports.view'),
  ('role_sales_rep', 'pipelines.view'), ('role_sales_rep', 'forecast.view'),
  ('role_sales_rep', 'leads.view_owned'), ('role_sales_rep', 'leads.create'),
  ('role_sales_rep', 'leads.edit'), ('role_sales_rep', 'leads.change_stage'),
  ('role_sales_rep', 'leads.mark_won'), ('role_sales_rep', 'leads.mark_lost'),
  ('role_sales_rep', 'leads.reopen'), ('role_sales_rep', 'leads.link_contact'),
  ('role_marketing', 'campaigns.manage'), ('role_marketing', 'journeys.manage'),
  ('role_marketing', 'reports.view'),
  ('role_workshop_manager', 'workshop.manage'), ('role_workshop_manager', 'reports.view'),
  ('role_technician', 'workshop.manage'),
  ('role_auditor', 'audit.view'), ('role_auditor', 'reports.view'),
  ('role_auditor', 'pipelines.view'), ('role_auditor', 'forecast.view'),
  ('role_auditor', 'leads.view_all')
ON CONFLICT DO NOTHING;

-- Preserve access without granting sales rights to workshop-only users.
INSERT INTO "UserRole" ("userId", "roleId")
SELECT "id", 'role_crm_admin' FROM "User" WHERE "role" = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO "UserRole" ("userId", "roleId")
SELECT "id", 'role_sales_rep' FROM "User"
WHERE "role" <> 'owner'
  AND (',' || REPLACE("modules", ' ', '') || ',') LIKE '%,crm,%'
ON CONFLICT DO NOTHING;

INSERT INTO "UserRole" ("userId", "roleId")
SELECT "id", 'role_technician' FROM "User"
WHERE "role" <> 'owner'
  AND (',' || REPLACE("modules", ' ', '') || ',') LIKE '%,workshop,%'
  AND (',' || REPLACE("modules", ' ', '') || ',') NOT LIKE '%,crm,%'
ON CONFLICT DO NOTHING;

ALTER TABLE "Lead" ADD COLUMN "pipelineId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "teamId" TEXT;
ALTER TABLE "Lead" ADD COLUMN "probability" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "Lead" ADD COLUMN "forecastCategory" TEXT NOT NULL DEFAULT 'pipeline';
ALTER TABLE "Lead" ADD COLUMN "expectedCloseDate" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "estimatedCostCents" INTEGER;
ALTER TABLE "Lead" ADD COLUMN "wonAt" TIMESTAMP(3);
ALTER TABLE "Lead" ADD COLUMN "lostAt" TIMESTAMP(3);

UPDATE "Lead" l SET "pipelineId" = s."pipelineId", "probability" = s."defaultProbability"
FROM "PipelineStage" s WHERE l."stageId" = s."id" AND l."pipelineId" IS NULL;
ALTER TABLE "Lead" ALTER COLUMN "pipelineId" SET NOT NULL;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "SalesPipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_probability_check" CHECK ("probability" BETWEEN 0 AND 100);
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_forecast_category_check" CHECK ("forecastCategory" IN ('pipeline','best_case','commit','closed','omitted'));
CREATE INDEX "Lead_pipeline_status_idx" ON "Lead"("pipelineId", "status");
CREATE INDEX "Lead_team_status_idx" ON "Lead"("teamId", "status");
CREATE INDEX "Lead_forecast_close_idx" ON "Lead"("forecastCategory", "expectedCloseDate");

-- Keep pipeline and default probability in sync for legacy Prisma writes.
CREATE OR REPLACE FUNCTION sync_lead_pipeline_forecast() RETURNS trigger AS $$
DECLARE stage_pipeline TEXT; stage_probability INTEGER;
BEGIN
  SELECT "pipelineId", "defaultProbability" INTO stage_pipeline, stage_probability
  FROM "PipelineStage" WHERE "id" = NEW."stageId";
  IF stage_pipeline IS NOT NULL THEN NEW."pipelineId" := stage_pipeline; END IF;
  IF TG_OP = 'INSERT' AND (NEW."probability" IS NULL OR NEW."probability" = 10) THEN
    NEW."probability" := COALESCE(stage_probability, 10);
  END IF;
  IF NEW."status" = 'won' THEN
    NEW."forecastCategory" := 'closed'; NEW."probability" := 100;
    NEW."wonAt" := COALESCE(NEW."wonAt", CURRENT_TIMESTAMP);
  ELSIF NEW."status" = 'lost' THEN
    NEW."forecastCategory" := 'omitted'; NEW."probability" := 0;
    NEW."lostAt" := COALESCE(NEW."lostAt", CURRENT_TIMESTAMP);
  ELSIF NEW."status" = 'open' THEN
    NEW."wonAt" := NULL; NEW."lostAt" := NULL;
    IF NEW."forecastCategory" IN ('closed','omitted') THEN
      NEW."forecastCategory" := 'pipeline';
      NEW."probability" := COALESCE(stage_probability, 10);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Lead_sync_pipeline_forecast"
BEFORE INSERT OR UPDATE OF "stageId", "status" ON "Lead"
FOR EACH ROW EXECUTE FUNCTION sync_lead_pipeline_forecast();

CREATE TABLE "ForecastSnapshot" (
  "id" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "pipelineId" TEXT,
  "teamId" TEXT,
  "userId" TEXT,
  "openValueCents" BIGINT NOT NULL,
  "weightedValueCents" BIGINT NOT NULL,
  "commitValueCents" BIGINT NOT NULL,
  "bestCaseValueCents" BIGINT NOT NULL,
  "opportunityCount" INTEGER NOT NULL,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "ForecastSnapshot" ADD CONSTRAINT "ForecastSnapshot_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "SalesPipeline"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ForecastSnapshot" ADD CONSTRAINT "ForecastSnapshot_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ForecastSnapshot" ADD CONSTRAINT "ForecastSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "ForecastSnapshot_period_idx" ON "ForecastSnapshot"("period", "capturedAt");
CREATE INDEX "ForecastSnapshot_scope_idx" ON "ForecastSnapshot"("pipelineId", "teamId", "userId", "capturedAt");

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorName" TEXT NOT NULL,
  "actorType" TEXT NOT NULL DEFAULT 'user',
  "eventType" TEXT NOT NULL,
  "entityType" TEXT,
  "entityId" TEXT,
  "summary" TEXT NOT NULL,
  "beforeJson" JSONB,
  "afterJson" JSONB,
  "changedFieldsJson" JSONB,
  "source" TEXT NOT NULL DEFAULT 'app',
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "correlationId" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");
CREATE INDEX "AuditEvent_entity_idx" ON "AuditEvent"("entityType", "entityId", "createdAt");
CREATE INDEX "AuditEvent_actor_idx" ON "AuditEvent"("actorUserId", "createdAt");
CREATE INDEX "AuditEvent_type_idx" ON "AuditEvent"("eventType", "createdAt");

-- Append-only audit protection at database level.
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AuditEvent_no_update" BEFORE UPDATE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
CREATE TRIGGER "AuditEvent_no_delete" BEFORE DELETE ON "AuditEvent" FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
