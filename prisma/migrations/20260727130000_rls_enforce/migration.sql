-- =============================================================================
-- RLS ENFORCEMENT MIGRATION
-- =============================================================================
-- This activates REAL Row Level Security enforcement on all 120 tables.
--
-- How it works:
--   - bypass_rls='on'        → basePrisma (trusted system path) bypasses all
--                               policies; used for migrations, admin jobs, and
--                               any server action that must see all tenants.
--   - app.current_tenant     → set per-request by the Prisma client extension
--                               in db.ts before every query on the tenant path.
--   - FORCE ROW LEVEL SECURITY → even the table owner (the DB role that owns
--                               the schema) is subject to these policies; no
--                               accidental bypass via ownership.
--   - Roll back               → set TENANT_ENFORCEMENT env var to 'off'; the
--                               application guard reads this before the DB is
--                               queried and skips setting app.current_tenant,
--                               effectively making every USING clause false for
--                               real tenants — so flip bypass_rls='on' in that
--                               path too, or drop the policies below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Activity
-- -----------------------------------------------------------------------------
ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Activity_tenant_isolation_placeholder" ON "Activity";
DROP POLICY IF EXISTS "Activity_tenant_isolation" ON "Activity";
CREATE POLICY "Activity_tenant_isolation" ON "Activity"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Activity" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AppSetting  [SPECIAL: tenantId IS NULL = global/shared]
-- -----------------------------------------------------------------------------
ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AppSetting_tenant_isolation_placeholder" ON "AppSetting";
DROP POLICY IF EXISTS "AppSetting_tenant_isolation" ON "AppSetting";
CREATE POLICY "AppSetting_tenant_isolation" ON "AppSetting"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" IS NULL
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AppSetting" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ApprovalStep
-- -----------------------------------------------------------------------------
ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ApprovalStep_tenant_isolation_placeholder" ON "ApprovalStep";
DROP POLICY IF EXISTS "ApprovalStep_tenant_isolation" ON "ApprovalStep";
CREATE POLICY "ApprovalStep_tenant_isolation" ON "ApprovalStep"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ApprovalStep" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AuditEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AuditEvent_tenant_isolation_placeholder" ON "AuditEvent";
DROP POLICY IF EXISTS "AuditEvent_tenant_isolation" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_isolation" ON "AuditEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AuditEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AuditLog
-- -----------------------------------------------------------------------------
ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AuditLog_tenant_isolation_placeholder" ON "AuditLog";
DROP POLICY IF EXISTS "AuditLog_tenant_isolation" ON "AuditLog";
CREATE POLICY "AuditLog_tenant_isolation" ON "AuditLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AuditLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AutomationLog
-- -----------------------------------------------------------------------------
ALTER TABLE "AutomationLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationLog_tenant_isolation_placeholder" ON "AutomationLog";
DROP POLICY IF EXISTS "AutomationLog_tenant_isolation" ON "AutomationLog";
CREATE POLICY "AutomationLog_tenant_isolation" ON "AutomationLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AutomationLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- AutomationRule
-- -----------------------------------------------------------------------------
ALTER TABLE "AutomationRule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationRule_tenant_isolation_placeholder" ON "AutomationRule";
DROP POLICY IF EXISTS "AutomationRule_tenant_isolation" ON "AutomationRule";
CREATE POLICY "AutomationRule_tenant_isolation" ON "AutomationRule"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "AutomationRule" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BatteryCheck
-- -----------------------------------------------------------------------------
ALTER TABLE "BatteryCheck" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BatteryCheck_tenant_isolation_placeholder" ON "BatteryCheck";
DROP POLICY IF EXISTS "BatteryCheck_tenant_isolation" ON "BatteryCheck";
CREATE POLICY "BatteryCheck_tenant_isolation" ON "BatteryCheck"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BatteryCheck" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BotFlow
-- -----------------------------------------------------------------------------
ALTER TABLE "BotFlow" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlow_tenant_isolation_placeholder" ON "BotFlow";
DROP POLICY IF EXISTS "BotFlow_tenant_isolation" ON "BotFlow";
CREATE POLICY "BotFlow_tenant_isolation" ON "BotFlow"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BotFlow" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- BotSession
-- -----------------------------------------------------------------------------
ALTER TABLE "BotSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotSession_tenant_isolation_placeholder" ON "BotSession";
DROP POLICY IF EXISTS "BotSession_tenant_isolation" ON "BotSession";
CREATE POLICY "BotSession_tenant_isolation" ON "BotSession"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "BotSession" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Campaign
-- -----------------------------------------------------------------------------
ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Campaign_tenant_isolation_placeholder" ON "Campaign";
DROP POLICY IF EXISTS "Campaign_tenant_isolation" ON "Campaign";
CREATE POLICY "Campaign_tenant_isolation" ON "Campaign"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Campaign" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CampaignConversion
-- -----------------------------------------------------------------------------
ALTER TABLE "CampaignConversion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignConversion_tenant_isolation_placeholder" ON "CampaignConversion";
DROP POLICY IF EXISTS "CampaignConversion_tenant_isolation" ON "CampaignConversion";
CREATE POLICY "CampaignConversion_tenant_isolation" ON "CampaignConversion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CampaignConversion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CampaignRecipient
-- -----------------------------------------------------------------------------
ALTER TABLE "CampaignRecipient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignRecipient_tenant_isolation_placeholder" ON "CampaignRecipient";
DROP POLICY IF EXISTS "CampaignRecipient_tenant_isolation" ON "CampaignRecipient";
CREATE POLICY "CampaignRecipient_tenant_isolation" ON "CampaignRecipient"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CampaignRecipient" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CampaignVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "CampaignVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignVersion_tenant_isolation_placeholder" ON "CampaignVersion";
DROP POLICY IF EXISTS "CampaignVersion_tenant_isolation" ON "CampaignVersion";
CREATE POLICY "CampaignVersion_tenant_isolation" ON "CampaignVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CampaignVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CannedReply
-- -----------------------------------------------------------------------------
ALTER TABLE "CannedReply" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CannedReply_tenant_isolation_placeholder" ON "CannedReply";
DROP POLICY IF EXISTS "CannedReply_tenant_isolation" ON "CannedReply";
CREATE POLICY "CannedReply_tenant_isolation" ON "CannedReply"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CannedReply" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ChannelIdentity
-- -----------------------------------------------------------------------------
ALTER TABLE "ChannelIdentity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChannelIdentity_tenant_isolation_placeholder" ON "ChannelIdentity";
DROP POLICY IF EXISTS "ChannelIdentity_tenant_isolation" ON "ChannelIdentity";
CREATE POLICY "ChannelIdentity_tenant_isolation" ON "ChannelIdentity"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ChannelIdentity" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Communication
-- -----------------------------------------------------------------------------
ALTER TABLE "Communication" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Communication_tenant_isolation_placeholder" ON "Communication";
DROP POLICY IF EXISTS "Communication_tenant_isolation" ON "Communication";
CREATE POLICY "Communication_tenant_isolation" ON "Communication"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Communication" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Competitor
-- -----------------------------------------------------------------------------
ALTER TABLE "Competitor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Competitor_tenant_isolation_placeholder" ON "Competitor";
DROP POLICY IF EXISTS "Competitor_tenant_isolation" ON "Competitor";
CREATE POLICY "Competitor_tenant_isolation" ON "Competitor"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Competitor" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CompetitorBrief
-- -----------------------------------------------------------------------------
ALTER TABLE "CompetitorBrief" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorBrief_tenant_isolation_placeholder" ON "CompetitorBrief";
DROP POLICY IF EXISTS "CompetitorBrief_tenant_isolation" ON "CompetitorBrief";
CREATE POLICY "CompetitorBrief_tenant_isolation" ON "CompetitorBrief"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CompetitorBrief" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CompetitorChange
-- -----------------------------------------------------------------------------
ALTER TABLE "CompetitorChange" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorChange_tenant_isolation_placeholder" ON "CompetitorChange";
DROP POLICY IF EXISTS "CompetitorChange_tenant_isolation" ON "CompetitorChange";
CREATE POLICY "CompetitorChange_tenant_isolation" ON "CompetitorChange"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CompetitorChange" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CompetitorSnapshot
-- -----------------------------------------------------------------------------
ALTER TABLE "CompetitorSnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorSnapshot_tenant_isolation_placeholder" ON "CompetitorSnapshot";
DROP POLICY IF EXISTS "CompetitorSnapshot_tenant_isolation" ON "CompetitorSnapshot";
CREATE POLICY "CompetitorSnapshot_tenant_isolation" ON "CompetitorSnapshot"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CompetitorSnapshot" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CompetitorSource
-- -----------------------------------------------------------------------------
ALTER TABLE "CompetitorSource" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorSource_tenant_isolation_placeholder" ON "CompetitorSource";
DROP POLICY IF EXISTS "CompetitorSource_tenant_isolation" ON "CompetitorSource";
CREATE POLICY "CompetitorSource_tenant_isolation" ON "CompetitorSource"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CompetitorSource" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ConsentRecord
-- -----------------------------------------------------------------------------
ALTER TABLE "ConsentRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConsentRecord_tenant_isolation_placeholder" ON "ConsentRecord";
DROP POLICY IF EXISTS "ConsentRecord_tenant_isolation" ON "ConsentRecord";
CREATE POLICY "ConsentRecord_tenant_isolation" ON "ConsentRecord"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ConsentRecord" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Contact
-- -----------------------------------------------------------------------------
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Contact_tenant_isolation_placeholder" ON "Contact";
DROP POLICY IF EXISTS "Contact_tenant_isolation" ON "Contact";
CREATE POLICY "Contact_tenant_isolation" ON "Contact"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Contact" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Conversation
-- -----------------------------------------------------------------------------
ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Conversation_tenant_isolation_placeholder" ON "Conversation";
DROP POLICY IF EXISTS "Conversation_tenant_isolation" ON "Conversation";
CREATE POLICY "Conversation_tenant_isolation" ON "Conversation"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Conversation" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomDocTemplate
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomDocTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomDocTemplate_tenant_isolation_placeholder" ON "CustomDocTemplate";
DROP POLICY IF EXISTS "CustomDocTemplate_tenant_isolation" ON "CustomDocTemplate";
CREATE POLICY "CustomDocTemplate_tenant_isolation" ON "CustomDocTemplate"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomDocTemplate" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomDocVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomDocVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomDocVersion_tenant_isolation_placeholder" ON "CustomDocVersion";
DROP POLICY IF EXISTS "CustomDocVersion_tenant_isolation" ON "CustomDocVersion";
CREATE POLICY "CustomDocVersion_tenant_isolation" ON "CustomDocVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomDocVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomFieldDef
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomFieldDef" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomFieldDef_tenant_isolation_placeholder" ON "CustomFieldDef";
DROP POLICY IF EXISTS "CustomFieldDef_tenant_isolation" ON "CustomFieldDef";
CREATE POLICY "CustomFieldDef_tenant_isolation" ON "CustomFieldDef"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomFieldDef" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomFieldValue
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomFieldValue" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomFieldValue_tenant_isolation_placeholder" ON "CustomFieldValue";
DROP POLICY IF EXISTS "CustomFieldValue_tenant_isolation" ON "CustomFieldValue";
CREATE POLICY "CustomFieldValue_tenant_isolation" ON "CustomFieldValue"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomFieldValue" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomerCase
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomerCase" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCase_tenant_isolation_placeholder" ON "CustomerCase";
DROP POLICY IF EXISTS "CustomerCase_tenant_isolation" ON "CustomerCase";
CREATE POLICY "CustomerCase_tenant_isolation" ON "CustomerCase"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomerCase" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomerCaseMessage
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomerCaseMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCaseMessage_tenant_isolation_placeholder" ON "CustomerCaseMessage";
DROP POLICY IF EXISTS "CustomerCaseMessage_tenant_isolation" ON "CustomerCaseMessage";
CREATE POLICY "CustomerCaseMessage_tenant_isolation" ON "CustomerCaseMessage"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomerCaseMessage" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- CustomerCaseTag
-- -----------------------------------------------------------------------------
ALTER TABLE "CustomerCaseTag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCaseTag_tenant_isolation_placeholder" ON "CustomerCaseTag";
DROP POLICY IF EXISTS "CustomerCaseTag_tenant_isolation" ON "CustomerCaseTag";
CREATE POLICY "CustomerCaseTag_tenant_isolation" ON "CustomerCaseTag"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "CustomerCaseTag" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- DemoVehicle
-- -----------------------------------------------------------------------------
ALTER TABLE "DemoVehicle" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DemoVehicle_tenant_isolation_placeholder" ON "DemoVehicle";
DROP POLICY IF EXISTS "DemoVehicle_tenant_isolation" ON "DemoVehicle";
CREATE POLICY "DemoVehicle_tenant_isolation" ON "DemoVehicle"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DemoVehicle" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- DocBuilderTemplate
-- -----------------------------------------------------------------------------
ALTER TABLE "DocBuilderTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocBuilderTemplate_tenant_isolation_placeholder" ON "DocBuilderTemplate";
DROP POLICY IF EXISTS "DocBuilderTemplate_tenant_isolation" ON "DocBuilderTemplate";
CREATE POLICY "DocBuilderTemplate_tenant_isolation" ON "DocBuilderTemplate"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DocBuilderTemplate" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- DocBuilderVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "DocBuilderVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocBuilderVersion_tenant_isolation_placeholder" ON "DocBuilderVersion";
DROP POLICY IF EXISTS "DocBuilderVersion_tenant_isolation" ON "DocBuilderVersion";
CREATE POLICY "DocBuilderVersion_tenant_isolation" ON "DocBuilderVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DocBuilderVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- DocInstance
-- -----------------------------------------------------------------------------
ALTER TABLE "DocInstance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocInstance_tenant_isolation_placeholder" ON "DocInstance";
DROP POLICY IF EXISTS "DocInstance_tenant_isolation" ON "DocInstance";
CREATE POLICY "DocInstance_tenant_isolation" ON "DocInstance"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DocInstance" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- DocTemplateRecord
-- -----------------------------------------------------------------------------
ALTER TABLE "DocTemplateRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocTemplateRecord_tenant_isolation_placeholder" ON "DocTemplateRecord";
DROP POLICY IF EXISTS "DocTemplateRecord_tenant_isolation" ON "DocTemplateRecord";
CREATE POLICY "DocTemplateRecord_tenant_isolation" ON "DocTemplateRecord"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "DocTemplateRecord" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Document
-- -----------------------------------------------------------------------------
ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Document_tenant_isolation_placeholder" ON "Document";
DROP POLICY IF EXISTS "Document_tenant_isolation" ON "Document";
CREATE POLICY "Document_tenant_isolation" ON "Document"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Document" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- EmailTemplate
-- -----------------------------------------------------------------------------
ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "EmailTemplate_tenant_isolation_placeholder" ON "EmailTemplate";
DROP POLICY IF EXISTS "EmailTemplate_tenant_isolation" ON "EmailTemplate";
CREATE POLICY "EmailTemplate_tenant_isolation" ON "EmailTemplate"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "EmailTemplate" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Fleet
-- -----------------------------------------------------------------------------
ALTER TABLE "Fleet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Fleet_tenant_isolation_placeholder" ON "Fleet";
DROP POLICY IF EXISTS "Fleet_tenant_isolation" ON "Fleet";
CREATE POLICY "Fleet_tenant_isolation" ON "Fleet"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Fleet" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ForecastSnapshot
-- -----------------------------------------------------------------------------
ALTER TABLE "ForecastSnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ForecastSnapshot_tenant_isolation_placeholder" ON "ForecastSnapshot";
DROP POLICY IF EXISTS "ForecastSnapshot_tenant_isolation" ON "ForecastSnapshot";
CREATE POLICY "ForecastSnapshot_tenant_isolation" ON "ForecastSnapshot"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ForecastSnapshot" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- GoodsReceipt
-- -----------------------------------------------------------------------------
ALTER TABLE "GoodsReceipt" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoodsReceipt_tenant_isolation_placeholder" ON "GoodsReceipt";
DROP POLICY IF EXISTS "GoodsReceipt_tenant_isolation" ON "GoodsReceipt";
CREATE POLICY "GoodsReceipt_tenant_isolation" ON "GoodsReceipt"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "GoodsReceipt" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- GoodsReceiptLine
-- -----------------------------------------------------------------------------
ALTER TABLE "GoodsReceiptLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoodsReceiptLine_tenant_isolation_placeholder" ON "GoodsReceiptLine";
DROP POLICY IF EXISTS "GoodsReceiptLine_tenant_isolation" ON "GoodsReceiptLine";
CREATE POLICY "GoodsReceiptLine_tenant_isolation" ON "GoodsReceiptLine"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "GoodsReceiptLine" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- GoogleReview
-- -----------------------------------------------------------------------------
ALTER TABLE "GoogleReview" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoogleReview_tenant_isolation_placeholder" ON "GoogleReview";
DROP POLICY IF EXISTS "GoogleReview_tenant_isolation" ON "GoogleReview";
CREATE POLICY "GoogleReview_tenant_isolation" ON "GoogleReview"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "GoogleReview" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JobCard
-- -----------------------------------------------------------------------------
ALTER TABLE "JobCard" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCard_tenant_isolation_placeholder" ON "JobCard";
DROP POLICY IF EXISTS "JobCard_tenant_isolation" ON "JobCard";
CREATE POLICY "JobCard_tenant_isolation" ON "JobCard"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JobCard" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JobCardApproval
-- -----------------------------------------------------------------------------
ALTER TABLE "JobCardApproval" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardApproval_tenant_isolation_placeholder" ON "JobCardApproval";
DROP POLICY IF EXISTS "JobCardApproval_tenant_isolation" ON "JobCardApproval";
CREATE POLICY "JobCardApproval_tenant_isolation" ON "JobCardApproval"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JobCardApproval" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JobCardInspectionItem
-- -----------------------------------------------------------------------------
ALTER TABLE "JobCardInspectionItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardInspectionItem_tenant_isolation_placeholder" ON "JobCardInspectionItem";
DROP POLICY IF EXISTS "JobCardInspectionItem_tenant_isolation" ON "JobCardInspectionItem";
CREATE POLICY "JobCardInspectionItem_tenant_isolation" ON "JobCardInspectionItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JobCardInspectionItem" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JobCardItem
-- -----------------------------------------------------------------------------
ALTER TABLE "JobCardItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardItem_tenant_isolation_placeholder" ON "JobCardItem";
DROP POLICY IF EXISTS "JobCardItem_tenant_isolation" ON "JobCardItem";
CREATE POLICY "JobCardItem_tenant_isolation" ON "JobCardItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JobCardItem" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JobCardTimeEntry
-- -----------------------------------------------------------------------------
ALTER TABLE "JobCardTimeEntry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardTimeEntry_tenant_isolation_placeholder" ON "JobCardTimeEntry";
DROP POLICY IF EXISTS "JobCardTimeEntry_tenant_isolation" ON "JobCardTimeEntry";
CREATE POLICY "JobCardTimeEntry_tenant_isolation" ON "JobCardTimeEntry"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JobCardTimeEntry" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Journey
-- -----------------------------------------------------------------------------
ALTER TABLE "Journey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Journey_tenant_isolation_placeholder" ON "Journey";
DROP POLICY IF EXISTS "Journey_tenant_isolation" ON "Journey";
CREATE POLICY "Journey_tenant_isolation" ON "Journey"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Journey" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JourneyEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "JourneyEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyEvent_tenant_isolation_placeholder" ON "JourneyEvent";
DROP POLICY IF EXISTS "JourneyEvent_tenant_isolation" ON "JourneyEvent";
CREATE POLICY "JourneyEvent_tenant_isolation" ON "JourneyEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JourneyEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JourneyRun
-- -----------------------------------------------------------------------------
ALTER TABLE "JourneyRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyRun_tenant_isolation_placeholder" ON "JourneyRun";
DROP POLICY IF EXISTS "JourneyRun_tenant_isolation" ON "JourneyRun";
CREATE POLICY "JourneyRun_tenant_isolation" ON "JourneyRun"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JourneyRun" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JourneyStepLog
-- -----------------------------------------------------------------------------
ALTER TABLE "JourneyStepLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyStepLog_tenant_isolation_placeholder" ON "JourneyStepLog";
DROP POLICY IF EXISTS "JourneyStepLog_tenant_isolation" ON "JourneyStepLog";
CREATE POLICY "JourneyStepLog_tenant_isolation" ON "JourneyStepLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JourneyStepLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- JourneyVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "JourneyVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyVersion_tenant_isolation_placeholder" ON "JourneyVersion";
DROP POLICY IF EXISTS "JourneyVersion_tenant_isolation" ON "JourneyVersion";
CREATE POLICY "JourneyVersion_tenant_isolation" ON "JourneyVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "JourneyVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Lead
-- -----------------------------------------------------------------------------
ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Lead_tenant_isolation_placeholder" ON "Lead";
DROP POLICY IF EXISTS "Lead_tenant_isolation" ON "Lead";
CREATE POLICY "Lead_tenant_isolation" ON "Lead"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Lead" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- LibraryDocument
-- -----------------------------------------------------------------------------
ALTER TABLE "LibraryDocument" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LibraryDocument_tenant_isolation_placeholder" ON "LibraryDocument";
DROP POLICY IF EXISTS "LibraryDocument_tenant_isolation" ON "LibraryDocument";
CREATE POLICY "LibraryDocument_tenant_isolation" ON "LibraryDocument"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "LibraryDocument" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- LibraryVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "LibraryVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LibraryVersion_tenant_isolation_placeholder" ON "LibraryVersion";
DROP POLICY IF EXISTS "LibraryVersion_tenant_isolation" ON "LibraryVersion";
CREATE POLICY "LibraryVersion_tenant_isolation" ON "LibraryVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "LibraryVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- MarketingAudienceVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "MarketingAudienceVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingAudienceVersion_tenant_isolation_placeholder" ON "MarketingAudienceVersion";
DROP POLICY IF EXISTS "MarketingAudienceVersion_tenant_isolation" ON "MarketingAudienceVersion";
CREATE POLICY "MarketingAudienceVersion_tenant_isolation" ON "MarketingAudienceVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "MarketingAudienceVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- MarketingCampaignEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "MarketingCampaignEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingCampaignEvent_tenant_isolation_placeholder" ON "MarketingCampaignEvent";
DROP POLICY IF EXISTS "MarketingCampaignEvent_tenant_isolation" ON "MarketingCampaignEvent";
CREATE POLICY "MarketingCampaignEvent_tenant_isolation" ON "MarketingCampaignEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "MarketingCampaignEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- MarketingTemplateVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "MarketingTemplateVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingTemplateVersion_tenant_isolation_placeholder" ON "MarketingTemplateVersion";
DROP POLICY IF EXISTS "MarketingTemplateVersion_tenant_isolation" ON "MarketingTemplateVersion";
CREATE POLICY "MarketingTemplateVersion_tenant_isolation" ON "MarketingTemplateVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "MarketingTemplateVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- MarketingTouch
-- -----------------------------------------------------------------------------
ALTER TABLE "MarketingTouch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingTouch_tenant_isolation_placeholder" ON "MarketingTouch";
DROP POLICY IF EXISTS "MarketingTouch_tenant_isolation" ON "MarketingTouch";
CREATE POLICY "MarketingTouch_tenant_isolation" ON "MarketingTouch"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "MarketingTouch" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- MileageLog
-- -----------------------------------------------------------------------------
ALTER TABLE "MileageLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MileageLog_tenant_isolation_placeholder" ON "MileageLog";
DROP POLICY IF EXISTS "MileageLog_tenant_isolation" ON "MileageLog";
CREATE POLICY "MileageLog_tenant_isolation" ON "MileageLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "MileageLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Part
-- -----------------------------------------------------------------------------
ALTER TABLE "Part" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Part_tenant_isolation_placeholder" ON "Part";
DROP POLICY IF EXISTS "Part_tenant_isolation" ON "Part";
CREATE POLICY "Part_tenant_isolation" ON "Part"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Part" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PartReservation
-- -----------------------------------------------------------------------------
ALTER TABLE "PartReservation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PartReservation_tenant_isolation_placeholder" ON "PartReservation";
DROP POLICY IF EXISTS "PartReservation_tenant_isolation" ON "PartReservation";
CREATE POLICY "PartReservation_tenant_isolation" ON "PartReservation"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PartReservation" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PipelineStage
-- -----------------------------------------------------------------------------
ALTER TABLE "PipelineStage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PipelineStage_tenant_isolation_placeholder" ON "PipelineStage";
DROP POLICY IF EXISTS "PipelineStage_tenant_isolation" ON "PipelineStage";
CREATE POLICY "PipelineStage_tenant_isolation" ON "PipelineStage"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PipelineStage" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PortalAccessGrant
-- -----------------------------------------------------------------------------
ALTER TABLE "PortalAccessGrant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalAccessGrant_tenant_isolation_placeholder" ON "PortalAccessGrant";
DROP POLICY IF EXISTS "PortalAccessGrant_tenant_isolation" ON "PortalAccessGrant";
CREATE POLICY "PortalAccessGrant_tenant_isolation" ON "PortalAccessGrant"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PortalAccessGrant" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PortalNotification
-- -----------------------------------------------------------------------------
ALTER TABLE "PortalNotification" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalNotification_tenant_isolation_placeholder" ON "PortalNotification";
DROP POLICY IF EXISTS "PortalNotification_tenant_isolation" ON "PortalNotification";
CREATE POLICY "PortalNotification_tenant_isolation" ON "PortalNotification"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PortalNotification" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PortalPreference
-- -----------------------------------------------------------------------------
ALTER TABLE "PortalPreference" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalPreference_tenant_isolation_placeholder" ON "PortalPreference";
DROP POLICY IF EXISTS "PortalPreference_tenant_isolation" ON "PortalPreference";
CREATE POLICY "PortalPreference_tenant_isolation" ON "PortalPreference"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PortalPreference" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PortalProfileChangeRequest
-- -----------------------------------------------------------------------------
ALTER TABLE "PortalProfileChangeRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalProfileChangeRequest_tenant_isolation_placeholder" ON "PortalProfileChangeRequest";
DROP POLICY IF EXISTS "PortalProfileChangeRequest_tenant_isolation" ON "PortalProfileChangeRequest";
CREATE POLICY "PortalProfileChangeRequest_tenant_isolation" ON "PortalProfileChangeRequest"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PortalProfileChangeRequest" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PortalUpload
-- -----------------------------------------------------------------------------
ALTER TABLE "PortalUpload" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalUpload_tenant_isolation_placeholder" ON "PortalUpload";
DROP POLICY IF EXISTS "PortalUpload_tenant_isolation" ON "PortalUpload";
CREATE POLICY "PortalUpload_tenant_isolation" ON "PortalUpload"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PortalUpload" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Product
-- -----------------------------------------------------------------------------
ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Product_tenant_isolation_placeholder" ON "Product";
DROP POLICY IF EXISTS "Product_tenant_isolation" ON "Product";
CREATE POLICY "Product_tenant_isolation" ON "Product"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Product" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ProductColor
-- -----------------------------------------------------------------------------
ALTER TABLE "ProductColor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ProductColor_tenant_isolation_placeholder" ON "ProductColor";
DROP POLICY IF EXISTS "ProductColor_tenant_isolation" ON "ProductColor";
CREATE POLICY "ProductColor_tenant_isolation" ON "ProductColor"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ProductColor" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PurchaseOrder
-- -----------------------------------------------------------------------------
ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PurchaseOrder_tenant_isolation_placeholder" ON "PurchaseOrder";
DROP POLICY IF EXISTS "PurchaseOrder_tenant_isolation" ON "PurchaseOrder";
CREATE POLICY "PurchaseOrder_tenant_isolation" ON "PurchaseOrder"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PurchaseOrder" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- PurchaseOrderLine
-- -----------------------------------------------------------------------------
ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PurchaseOrderLine_tenant_isolation_placeholder" ON "PurchaseOrderLine";
DROP POLICY IF EXISTS "PurchaseOrderLine_tenant_isolation" ON "PurchaseOrderLine";
CREATE POLICY "PurchaseOrderLine_tenant_isolation" ON "PurchaseOrderLine"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "PurchaseOrderLine" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Quote
-- -----------------------------------------------------------------------------
ALTER TABLE "Quote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Quote_tenant_isolation_placeholder" ON "Quote";
DROP POLICY IF EXISTS "Quote_tenant_isolation" ON "Quote";
CREATE POLICY "Quote_tenant_isolation" ON "Quote"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Quote" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- QuoteFee
-- -----------------------------------------------------------------------------
ALTER TABLE "QuoteFee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QuoteFee_tenant_isolation_placeholder" ON "QuoteFee";
DROP POLICY IF EXISTS "QuoteFee_tenant_isolation" ON "QuoteFee";
CREATE POLICY "QuoteFee_tenant_isolation" ON "QuoteFee"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "QuoteFee" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- QuoteItem
-- -----------------------------------------------------------------------------
ALTER TABLE "QuoteItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QuoteItem_tenant_isolation_placeholder" ON "QuoteItem";
DROP POLICY IF EXISTS "QuoteItem_tenant_isolation" ON "QuoteItem";
CREATE POLICY "QuoteItem_tenant_isolation" ON "QuoteItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "QuoteItem" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Recall
-- -----------------------------------------------------------------------------
ALTER TABLE "Recall" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Recall_tenant_isolation_placeholder" ON "Recall";
DROP POLICY IF EXISTS "Recall_tenant_isolation" ON "Recall";
CREATE POLICY "Recall_tenant_isolation" ON "Recall"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Recall" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Referral
-- -----------------------------------------------------------------------------
ALTER TABLE "Referral" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Referral_tenant_isolation_placeholder" ON "Referral";
DROP POLICY IF EXISTS "Referral_tenant_isolation" ON "Referral";
CREATE POLICY "Referral_tenant_isolation" ON "Referral"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Referral" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ResearchNote
-- -----------------------------------------------------------------------------
ALTER TABLE "ResearchNote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ResearchNote_tenant_isolation_placeholder" ON "ResearchNote";
DROP POLICY IF EXISTS "ResearchNote_tenant_isolation" ON "ResearchNote";
CREATE POLICY "ResearchNote_tenant_isolation" ON "ResearchNote"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ResearchNote" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ReusableBlock
-- -----------------------------------------------------------------------------
ALTER TABLE "ReusableBlock" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ReusableBlock_tenant_isolation_placeholder" ON "ReusableBlock";
DROP POLICY IF EXISTS "ReusableBlock_tenant_isolation" ON "ReusableBlock";
CREATE POLICY "ReusableBlock_tenant_isolation" ON "ReusableBlock"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ReusableBlock" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Role  [SPECIAL: tenantId IS NULL = global/shared]
-- -----------------------------------------------------------------------------
ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Role_tenant_isolation_placeholder" ON "Role";
DROP POLICY IF EXISTS "Role_tenant_isolation" ON "Role";
CREATE POLICY "Role_tenant_isolation" ON "Role"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" IS NULL
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Role" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- RolePermission  [SPECIAL: tenantId IS NULL = global/shared]
-- -----------------------------------------------------------------------------
ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RolePermission_tenant_isolation_placeholder" ON "RolePermission";
DROP POLICY IF EXISTS "RolePermission_tenant_isolation" ON "RolePermission";
CREATE POLICY "RolePermission_tenant_isolation" ON "RolePermission"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" IS NULL
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "RolePermission" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SalesPipeline
-- -----------------------------------------------------------------------------
ALTER TABLE "SalesPipeline" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SalesPipeline_tenant_isolation_placeholder" ON "SalesPipeline";
DROP POLICY IF EXISTS "SalesPipeline_tenant_isolation" ON "SalesPipeline";
CREATE POLICY "SalesPipeline_tenant_isolation" ON "SalesPipeline"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SalesPipeline" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SavedView
-- -----------------------------------------------------------------------------
ALTER TABLE "SavedView" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SavedView_tenant_isolation_placeholder" ON "SavedView";
DROP POLICY IF EXISTS "SavedView_tenant_isolation" ON "SavedView";
CREATE POLICY "SavedView_tenant_isolation" ON "SavedView"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SavedView" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Segment
-- -----------------------------------------------------------------------------
ALTER TABLE "Segment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Segment_tenant_isolation_placeholder" ON "Segment";
DROP POLICY IF EXISTS "Segment_tenant_isolation" ON "Segment";
CREATE POLICY "Segment_tenant_isolation" ON "Segment"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Segment" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ServicePackage
-- -----------------------------------------------------------------------------
ALTER TABLE "ServicePackage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServicePackage_tenant_isolation_placeholder" ON "ServicePackage";
DROP POLICY IF EXISTS "ServicePackage_tenant_isolation" ON "ServicePackage";
CREATE POLICY "ServicePackage_tenant_isolation" ON "ServicePackage"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ServicePackage" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ServicePackageItem
-- -----------------------------------------------------------------------------
ALTER TABLE "ServicePackageItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServicePackageItem_tenant_isolation_placeholder" ON "ServicePackageItem";
DROP POLICY IF EXISTS "ServicePackageItem_tenant_isolation" ON "ServicePackageItem";
CREATE POLICY "ServicePackageItem_tenant_isolation" ON "ServicePackageItem"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ServicePackageItem" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ServiceRecord
-- -----------------------------------------------------------------------------
ALTER TABLE "ServiceRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServiceRecord_tenant_isolation_placeholder" ON "ServiceRecord";
DROP POLICY IF EXISTS "ServiceRecord_tenant_isolation" ON "ServiceRecord";
CREATE POLICY "ServiceRecord_tenant_isolation" ON "ServiceRecord"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ServiceRecord" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- ServiceReminderLog
-- -----------------------------------------------------------------------------
ALTER TABLE "ServiceReminderLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServiceReminderLog_tenant_isolation_placeholder" ON "ServiceReminderLog";
DROP POLICY IF EXISTS "ServiceReminderLog_tenant_isolation" ON "ServiceReminderLog";
CREATE POLICY "ServiceReminderLog_tenant_isolation" ON "ServiceReminderLog"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "ServiceReminderLog" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignWorkflow
-- -----------------------------------------------------------------------------
ALTER TABLE "SignWorkflow" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignWorkflow_tenant_isolation_placeholder" ON "SignWorkflow";
DROP POLICY IF EXISTS "SignWorkflow_tenant_isolation" ON "SignWorkflow";
CREATE POLICY "SignWorkflow_tenant_isolation" ON "SignWorkflow"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignWorkflow" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignatureEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "SignatureEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureEvent_tenant_isolation_placeholder" ON "SignatureEvent";
DROP POLICY IF EXISTS "SignatureEvent_tenant_isolation" ON "SignatureEvent";
CREATE POLICY "SignatureEvent_tenant_isolation" ON "SignatureEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignatureField
-- -----------------------------------------------------------------------------
ALTER TABLE "SignatureField" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureField_tenant_isolation_placeholder" ON "SignatureField";
DROP POLICY IF EXISTS "SignatureField_tenant_isolation" ON "SignatureField";
CREATE POLICY "SignatureField_tenant_isolation" ON "SignatureField"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureField" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignatureFieldResponse
-- -----------------------------------------------------------------------------
ALTER TABLE "SignatureFieldResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureFieldResponse_tenant_isolation_placeholder" ON "SignatureFieldResponse";
DROP POLICY IF EXISTS "SignatureFieldResponse_tenant_isolation" ON "SignatureFieldResponse";
CREATE POLICY "SignatureFieldResponse_tenant_isolation" ON "SignatureFieldResponse"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureFieldResponse" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignatureRecipient
-- -----------------------------------------------------------------------------
ALTER TABLE "SignatureRecipient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureRecipient_tenant_isolation_placeholder" ON "SignatureRecipient";
DROP POLICY IF EXISTS "SignatureRecipient_tenant_isolation" ON "SignatureRecipient";
CREATE POLICY "SignatureRecipient_tenant_isolation" ON "SignatureRecipient"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureRecipient" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SignatureRequest
-- -----------------------------------------------------------------------------
ALTER TABLE "SignatureRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureRequest_tenant_isolation_placeholder" ON "SignatureRequest";
DROP POLICY IF EXISTS "SignatureRequest_tenant_isolation" ON "SignatureRequest";
CREATE POLICY "SignatureRequest_tenant_isolation" ON "SignatureRequest"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureRequest" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- StockEvent
-- -----------------------------------------------------------------------------
ALTER TABLE "StockEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockEvent_tenant_isolation_placeholder" ON "StockEvent";
DROP POLICY IF EXISTS "StockEvent_tenant_isolation" ON "StockEvent";
CREATE POLICY "StockEvent_tenant_isolation" ON "StockEvent"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StockEvent" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- StockReservation
-- -----------------------------------------------------------------------------
ALTER TABLE "StockReservation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockReservation_tenant_isolation_placeholder" ON "StockReservation";
DROP POLICY IF EXISTS "StockReservation_tenant_isolation" ON "StockReservation";
CREATE POLICY "StockReservation_tenant_isolation" ON "StockReservation"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StockReservation" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- StockUnit
-- -----------------------------------------------------------------------------
ALTER TABLE "StockUnit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockUnit_tenant_isolation_placeholder" ON "StockUnit";
DROP POLICY IF EXISTS "StockUnit_tenant_isolation" ON "StockUnit";
CREATE POLICY "StockUnit_tenant_isolation" ON "StockUnit"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "StockUnit" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SupportMailbox
-- -----------------------------------------------------------------------------
ALTER TABLE "SupportMailbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SupportMailbox_tenant_isolation_placeholder" ON "SupportMailbox";
DROP POLICY IF EXISTS "SupportMailbox_tenant_isolation" ON "SupportMailbox";
CREATE POLICY "SupportMailbox_tenant_isolation" ON "SupportMailbox"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SupportMailbox" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SupportTag
-- -----------------------------------------------------------------------------
ALTER TABLE "SupportTag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SupportTag_tenant_isolation_placeholder" ON "SupportTag";
DROP POLICY IF EXISTS "SupportTag_tenant_isolation" ON "SupportTag";
CREATE POLICY "SupportTag_tenant_isolation" ON "SupportTag"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SupportTag" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Survey
-- -----------------------------------------------------------------------------
ALTER TABLE "Survey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Survey_tenant_isolation_placeholder" ON "Survey";
DROP POLICY IF EXISTS "Survey_tenant_isolation" ON "Survey";
CREATE POLICY "Survey_tenant_isolation" ON "Survey"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Survey" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SurveyDistribution
-- -----------------------------------------------------------------------------
ALTER TABLE "SurveyDistribution" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyDistribution_tenant_isolation_placeholder" ON "SurveyDistribution";
DROP POLICY IF EXISTS "SurveyDistribution_tenant_isolation" ON "SurveyDistribution";
CREATE POLICY "SurveyDistribution_tenant_isolation" ON "SurveyDistribution"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SurveyDistribution" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SurveyFollowUp
-- -----------------------------------------------------------------------------
ALTER TABLE "SurveyFollowUp" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyFollowUp_tenant_isolation_placeholder" ON "SurveyFollowUp";
DROP POLICY IF EXISTS "SurveyFollowUp_tenant_isolation" ON "SurveyFollowUp";
CREATE POLICY "SurveyFollowUp_tenant_isolation" ON "SurveyFollowUp"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SurveyFollowUp" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SurveyResponse
-- -----------------------------------------------------------------------------
ALTER TABLE "SurveyResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyResponse_tenant_isolation_placeholder" ON "SurveyResponse";
DROP POLICY IF EXISTS "SurveyResponse_tenant_isolation" ON "SurveyResponse";
CREATE POLICY "SurveyResponse_tenant_isolation" ON "SurveyResponse"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SurveyResponse" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- SurveyVersion
-- -----------------------------------------------------------------------------
ALTER TABLE "SurveyVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyVersion_tenant_isolation_placeholder" ON "SurveyVersion";
DROP POLICY IF EXISTS "SurveyVersion_tenant_isolation" ON "SurveyVersion";
CREATE POLICY "SurveyVersion_tenant_isolation" ON "SurveyVersion"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SurveyVersion" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Tag
-- -----------------------------------------------------------------------------
ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Tag_tenant_isolation_placeholder" ON "Tag";
DROP POLICY IF EXISTS "Tag_tenant_isolation" ON "Tag";
CREATE POLICY "Tag_tenant_isolation" ON "Tag"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Tag" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Target
-- -----------------------------------------------------------------------------
ALTER TABLE "Target" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Target_tenant_isolation_placeholder" ON "Target";
DROP POLICY IF EXISTS "Target_tenant_isolation" ON "Target";
CREATE POLICY "Target_tenant_isolation" ON "Target"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Target" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Team
-- -----------------------------------------------------------------------------
ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Team_tenant_isolation_placeholder" ON "Team";
DROP POLICY IF EXISTS "Team_tenant_isolation" ON "Team";
CREATE POLICY "Team_tenant_isolation" ON "Team"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Team" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TeamMember
-- -----------------------------------------------------------------------------
ALTER TABLE "TeamMember" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TeamMember_tenant_isolation_placeholder" ON "TeamMember";
DROP POLICY IF EXISTS "TeamMember_tenant_isolation" ON "TeamMember";
CREATE POLICY "TeamMember_tenant_isolation" ON "TeamMember"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TeamMember" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TenantApiKey
-- -----------------------------------------------------------------------------
ALTER TABLE "TenantApiKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantApiKey_tenant_isolation_placeholder" ON "TenantApiKey";
DROP POLICY IF EXISTS "TenantApiKey_tenant_isolation" ON "TenantApiKey";
CREATE POLICY "TenantApiKey_tenant_isolation" ON "TenantApiKey"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantApiKey" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TenantIntegrationCredential
-- -----------------------------------------------------------------------------
ALTER TABLE "TenantIntegrationCredential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantIntegrationCredential_tenant_isolation_placeholder" ON "TenantIntegrationCredential";
DROP POLICY IF EXISTS "TenantIntegrationCredential_tenant_isolation" ON "TenantIntegrationCredential";
CREATE POLICY "TenantIntegrationCredential_tenant_isolation" ON "TenantIntegrationCredential"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantIntegrationCredential" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TestDriveAsset
-- -----------------------------------------------------------------------------
ALTER TABLE "TestDriveAsset" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TestDriveAsset_tenant_isolation_placeholder" ON "TestDriveAsset";
DROP POLICY IF EXISTS "TestDriveAsset_tenant_isolation" ON "TestDriveAsset";
CREATE POLICY "TestDriveAsset_tenant_isolation" ON "TestDriveAsset"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TestDriveAsset" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TestDriveBooking
-- -----------------------------------------------------------------------------
ALTER TABLE "TestDriveBooking" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TestDriveBooking_tenant_isolation_placeholder" ON "TestDriveBooking";
DROP POLICY IF EXISTS "TestDriveBooking_tenant_isolation" ON "TestDriveBooking";
CREATE POLICY "TestDriveBooking_tenant_isolation" ON "TestDriveBooking"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TestDriveBooking" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- TimelinePin
-- -----------------------------------------------------------------------------
ALTER TABLE "TimelinePin" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TimelinePin_tenant_isolation_placeholder" ON "TimelinePin";
DROP POLICY IF EXISTS "TimelinePin_tenant_isolation" ON "TimelinePin";
CREATE POLICY "TimelinePin_tenant_isolation" ON "TimelinePin"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TimelinePin" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- UserRole
-- -----------------------------------------------------------------------------
ALTER TABLE "UserRole" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "UserRole_tenant_isolation_placeholder" ON "UserRole";
DROP POLICY IF EXISTS "UserRole_tenant_isolation" ON "UserRole";
CREATE POLICY "UserRole_tenant_isolation" ON "UserRole"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "UserRole" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- UserSession
-- -----------------------------------------------------------------------------
ALTER TABLE "UserSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "UserSession_tenant_isolation_placeholder" ON "UserSession";
DROP POLICY IF EXISTS "UserSession_tenant_isolation" ON "UserSession";
CREATE POLICY "UserSession_tenant_isolation" ON "UserSession"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "UserSession" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- Vehicle
-- -----------------------------------------------------------------------------
ALTER TABLE "Vehicle" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Vehicle_tenant_isolation_placeholder" ON "Vehicle";
DROP POLICY IF EXISTS "Vehicle_tenant_isolation" ON "Vehicle";
CREATE POLICY "Vehicle_tenant_isolation" ON "Vehicle"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "Vehicle" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- WarrantyClaim
-- -----------------------------------------------------------------------------
ALTER TABLE "WarrantyClaim" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WarrantyClaim_tenant_isolation_placeholder" ON "WarrantyClaim";
DROP POLICY IF EXISTS "WarrantyClaim_tenant_isolation" ON "WarrantyClaim";
CREATE POLICY "WarrantyClaim_tenant_isolation" ON "WarrantyClaim"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "WarrantyClaim" FORCE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- WorkshopBay
-- -----------------------------------------------------------------------------
ALTER TABLE "WorkshopBay" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WorkshopBay_tenant_isolation_placeholder" ON "WorkshopBay";
DROP POLICY IF EXISTS "WorkshopBay_tenant_isolation" ON "WorkshopBay";
CREATE POLICY "WorkshopBay_tenant_isolation" ON "WorkshopBay"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "WorkshopBay" FORCE ROW LEVEL SECURITY;
