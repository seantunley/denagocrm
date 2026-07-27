-- RLS SCAFFOLDING -- SAFE / DORMANT STAGE ONLY. Read this before touching it.
--
-- This migration ENABLES Postgres Row-Level Security on every tenant-scoped
-- table (every model NOT in tenantGuard.ts GLOBAL_MODELS, i.e. every model
-- that carries a tenantId column -- generated programmatically from
-- prisma/*.prisma, 120 tables, cross-checked against
-- tests/tenantSchemaContract.test.ts so nothing is missed or stale).
--
-- CRITICAL -- WHY THIS IS SAFE TO SHIP TODAY (verify this before ever changing it):
--   1. It does NOT run "FORCE ROW LEVEL SECURITY". Postgres exempts a
--      table's OWNING role from RLS unless FORCE is also applied -- and the
--      app's DB connection is that owning role. So ENABLE alone, without
--      FORCE, is a genuine no-op for every query this app issues, today and
--      until someone deliberately adds FORCE.
--   2. Even if FORCE were added later without also tightening the policy
--      below, the policy is PERMISSIVE ("USING (true) WITH CHECK (true)") --
--      it allows every row, so it still would not filter anything.
--   3. Net effect of this migration alone: zero behavioural change. It
--      exists purely to stage the RLS objects so the real activation later
--      is a small, reviewable diff (tighten the policy + add FORCE), not a
--      from-scratch migration written under time pressure at flip time.
--
-- WHAT STILL HAS TO HAPPEN BEFORE THIS IS A REAL SECURITY BOUNDARY (do NOT
-- flip these independently of each other -- see NEXT-STEPS.md):
--   a. The app must SET a session-local Postgres variable (e.g.
--      "app.current_tenant") at the START of every request/transaction,
--      from the existing AsyncLocalStorage tenant scope
--      (src/lib/tenantScope.ts). Nothing in this codebase sets that
--      variable yet.
--   b. A verified BYPASS path for legitimate cross-tenant system/cron work
--      (src/lib/tenantScope.ts's "system" scope, backups, etc.) -- e.g. a
--      dedicated Postgres role with BYPASSRLS, or a policy clause keyed to
--      a second session var the app sets only for those code paths.
--   c. Each placeholder policy below tightened from "USING (true)" to the
--      real predicate, e.g.
--        USING ("tenantId" = current_setting('app.current_tenant', true))
--      (exact form depends on how (a) is implemented -- text-cast, NULL
--      handling for legitimately-global historic rows, etc.)
--   d. ONLY THEN: "ALTER TABLE ... FORCE ROW LEVEL SECURITY" per table.
--   e. Roll out (a)-(d) monitor-mode first against a throwaway/dev database
--      with two real tenants seeded, prove cross-tenant reads/writes fail
--      closed, THEN stage on prod behind the same off/monitor/enforce
--      discipline already used for the app-layer guard
--      (src/lib/tenantEnforcement.ts) -- NEVER force RLS on prod without
--      that proof, since (unlike the app guard) RLS is NOT gated by
--      tenantEnforcing() -- Postgres has no idea that flag exists.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY is a no-op if already enabled;
-- CREATE POLICY has no IF NOT EXISTS in Postgres, so each is preceded by a
-- DROP POLICY IF EXISTS, making the whole file safely re-runnable.

ALTER TABLE "Activity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Activity_tenant_isolation_placeholder" ON "Activity";
CREATE POLICY "Activity_tenant_isolation_placeholder" ON "Activity" USING (true) WITH CHECK (true);

ALTER TABLE "AppSetting" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AppSetting_tenant_isolation_placeholder" ON "AppSetting";
CREATE POLICY "AppSetting_tenant_isolation_placeholder" ON "AppSetting" USING (true) WITH CHECK (true);

ALTER TABLE "ApprovalStep" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ApprovalStep_tenant_isolation_placeholder" ON "ApprovalStep";
CREATE POLICY "ApprovalStep_tenant_isolation_placeholder" ON "ApprovalStep" USING (true) WITH CHECK (true);

ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AuditEvent_tenant_isolation_placeholder" ON "AuditEvent";
CREATE POLICY "AuditEvent_tenant_isolation_placeholder" ON "AuditEvent" USING (true) WITH CHECK (true);

ALTER TABLE "AuditLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AuditLog_tenant_isolation_placeholder" ON "AuditLog";
CREATE POLICY "AuditLog_tenant_isolation_placeholder" ON "AuditLog" USING (true) WITH CHECK (true);

ALTER TABLE "AutomationLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationLog_tenant_isolation_placeholder" ON "AutomationLog";
CREATE POLICY "AutomationLog_tenant_isolation_placeholder" ON "AutomationLog" USING (true) WITH CHECK (true);

ALTER TABLE "AutomationRule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "AutomationRule_tenant_isolation_placeholder" ON "AutomationRule";
CREATE POLICY "AutomationRule_tenant_isolation_placeholder" ON "AutomationRule" USING (true) WITH CHECK (true);

ALTER TABLE "BatteryCheck" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BatteryCheck_tenant_isolation_placeholder" ON "BatteryCheck";
CREATE POLICY "BatteryCheck_tenant_isolation_placeholder" ON "BatteryCheck" USING (true) WITH CHECK (true);

ALTER TABLE "BotFlow" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotFlow_tenant_isolation_placeholder" ON "BotFlow";
CREATE POLICY "BotFlow_tenant_isolation_placeholder" ON "BotFlow" USING (true) WITH CHECK (true);

ALTER TABLE "BotSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "BotSession_tenant_isolation_placeholder" ON "BotSession";
CREATE POLICY "BotSession_tenant_isolation_placeholder" ON "BotSession" USING (true) WITH CHECK (true);

ALTER TABLE "Campaign" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Campaign_tenant_isolation_placeholder" ON "Campaign";
CREATE POLICY "Campaign_tenant_isolation_placeholder" ON "Campaign" USING (true) WITH CHECK (true);

ALTER TABLE "CampaignConversion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignConversion_tenant_isolation_placeholder" ON "CampaignConversion";
CREATE POLICY "CampaignConversion_tenant_isolation_placeholder" ON "CampaignConversion" USING (true) WITH CHECK (true);

ALTER TABLE "CampaignRecipient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignRecipient_tenant_isolation_placeholder" ON "CampaignRecipient";
CREATE POLICY "CampaignRecipient_tenant_isolation_placeholder" ON "CampaignRecipient" USING (true) WITH CHECK (true);

ALTER TABLE "CampaignVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CampaignVersion_tenant_isolation_placeholder" ON "CampaignVersion";
CREATE POLICY "CampaignVersion_tenant_isolation_placeholder" ON "CampaignVersion" USING (true) WITH CHECK (true);

ALTER TABLE "CannedReply" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CannedReply_tenant_isolation_placeholder" ON "CannedReply";
CREATE POLICY "CannedReply_tenant_isolation_placeholder" ON "CannedReply" USING (true) WITH CHECK (true);

ALTER TABLE "ChannelIdentity" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ChannelIdentity_tenant_isolation_placeholder" ON "ChannelIdentity";
CREATE POLICY "ChannelIdentity_tenant_isolation_placeholder" ON "ChannelIdentity" USING (true) WITH CHECK (true);

ALTER TABLE "Communication" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Communication_tenant_isolation_placeholder" ON "Communication";
CREATE POLICY "Communication_tenant_isolation_placeholder" ON "Communication" USING (true) WITH CHECK (true);

ALTER TABLE "Competitor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Competitor_tenant_isolation_placeholder" ON "Competitor";
CREATE POLICY "Competitor_tenant_isolation_placeholder" ON "Competitor" USING (true) WITH CHECK (true);

ALTER TABLE "CompetitorBrief" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorBrief_tenant_isolation_placeholder" ON "CompetitorBrief";
CREATE POLICY "CompetitorBrief_tenant_isolation_placeholder" ON "CompetitorBrief" USING (true) WITH CHECK (true);

ALTER TABLE "CompetitorChange" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorChange_tenant_isolation_placeholder" ON "CompetitorChange";
CREATE POLICY "CompetitorChange_tenant_isolation_placeholder" ON "CompetitorChange" USING (true) WITH CHECK (true);

ALTER TABLE "CompetitorSnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorSnapshot_tenant_isolation_placeholder" ON "CompetitorSnapshot";
CREATE POLICY "CompetitorSnapshot_tenant_isolation_placeholder" ON "CompetitorSnapshot" USING (true) WITH CHECK (true);

ALTER TABLE "CompetitorSource" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CompetitorSource_tenant_isolation_placeholder" ON "CompetitorSource";
CREATE POLICY "CompetitorSource_tenant_isolation_placeholder" ON "CompetitorSource" USING (true) WITH CHECK (true);

ALTER TABLE "ConsentRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ConsentRecord_tenant_isolation_placeholder" ON "ConsentRecord";
CREATE POLICY "ConsentRecord_tenant_isolation_placeholder" ON "ConsentRecord" USING (true) WITH CHECK (true);

ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Contact_tenant_isolation_placeholder" ON "Contact";
CREATE POLICY "Contact_tenant_isolation_placeholder" ON "Contact" USING (true) WITH CHECK (true);

ALTER TABLE "Conversation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Conversation_tenant_isolation_placeholder" ON "Conversation";
CREATE POLICY "Conversation_tenant_isolation_placeholder" ON "Conversation" USING (true) WITH CHECK (true);

ALTER TABLE "CustomDocTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomDocTemplate_tenant_isolation_placeholder" ON "CustomDocTemplate";
CREATE POLICY "CustomDocTemplate_tenant_isolation_placeholder" ON "CustomDocTemplate" USING (true) WITH CHECK (true);

ALTER TABLE "CustomDocVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomDocVersion_tenant_isolation_placeholder" ON "CustomDocVersion";
CREATE POLICY "CustomDocVersion_tenant_isolation_placeholder" ON "CustomDocVersion" USING (true) WITH CHECK (true);

ALTER TABLE "CustomFieldDef" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomFieldDef_tenant_isolation_placeholder" ON "CustomFieldDef";
CREATE POLICY "CustomFieldDef_tenant_isolation_placeholder" ON "CustomFieldDef" USING (true) WITH CHECK (true);

ALTER TABLE "CustomFieldValue" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomFieldValue_tenant_isolation_placeholder" ON "CustomFieldValue";
CREATE POLICY "CustomFieldValue_tenant_isolation_placeholder" ON "CustomFieldValue" USING (true) WITH CHECK (true);

ALTER TABLE "CustomerCase" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCase_tenant_isolation_placeholder" ON "CustomerCase";
CREATE POLICY "CustomerCase_tenant_isolation_placeholder" ON "CustomerCase" USING (true) WITH CHECK (true);

ALTER TABLE "CustomerCaseMessage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCaseMessage_tenant_isolation_placeholder" ON "CustomerCaseMessage";
CREATE POLICY "CustomerCaseMessage_tenant_isolation_placeholder" ON "CustomerCaseMessage" USING (true) WITH CHECK (true);

ALTER TABLE "CustomerCaseTag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "CustomerCaseTag_tenant_isolation_placeholder" ON "CustomerCaseTag";
CREATE POLICY "CustomerCaseTag_tenant_isolation_placeholder" ON "CustomerCaseTag" USING (true) WITH CHECK (true);

ALTER TABLE "DemoVehicle" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DemoVehicle_tenant_isolation_placeholder" ON "DemoVehicle";
CREATE POLICY "DemoVehicle_tenant_isolation_placeholder" ON "DemoVehicle" USING (true) WITH CHECK (true);

ALTER TABLE "DocBuilderTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocBuilderTemplate_tenant_isolation_placeholder" ON "DocBuilderTemplate";
CREATE POLICY "DocBuilderTemplate_tenant_isolation_placeholder" ON "DocBuilderTemplate" USING (true) WITH CHECK (true);

ALTER TABLE "DocBuilderVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocBuilderVersion_tenant_isolation_placeholder" ON "DocBuilderVersion";
CREATE POLICY "DocBuilderVersion_tenant_isolation_placeholder" ON "DocBuilderVersion" USING (true) WITH CHECK (true);

ALTER TABLE "DocInstance" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocInstance_tenant_isolation_placeholder" ON "DocInstance";
CREATE POLICY "DocInstance_tenant_isolation_placeholder" ON "DocInstance" USING (true) WITH CHECK (true);

ALTER TABLE "DocTemplateRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocTemplateRecord_tenant_isolation_placeholder" ON "DocTemplateRecord";
CREATE POLICY "DocTemplateRecord_tenant_isolation_placeholder" ON "DocTemplateRecord" USING (true) WITH CHECK (true);

ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Document_tenant_isolation_placeholder" ON "Document";
CREATE POLICY "Document_tenant_isolation_placeholder" ON "Document" USING (true) WITH CHECK (true);

ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "EmailTemplate_tenant_isolation_placeholder" ON "EmailTemplate";
CREATE POLICY "EmailTemplate_tenant_isolation_placeholder" ON "EmailTemplate" USING (true) WITH CHECK (true);

ALTER TABLE "Fleet" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Fleet_tenant_isolation_placeholder" ON "Fleet";
CREATE POLICY "Fleet_tenant_isolation_placeholder" ON "Fleet" USING (true) WITH CHECK (true);

ALTER TABLE "ForecastSnapshot" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ForecastSnapshot_tenant_isolation_placeholder" ON "ForecastSnapshot";
CREATE POLICY "ForecastSnapshot_tenant_isolation_placeholder" ON "ForecastSnapshot" USING (true) WITH CHECK (true);

ALTER TABLE "GoodsReceipt" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoodsReceipt_tenant_isolation_placeholder" ON "GoodsReceipt";
CREATE POLICY "GoodsReceipt_tenant_isolation_placeholder" ON "GoodsReceipt" USING (true) WITH CHECK (true);

ALTER TABLE "GoodsReceiptLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoodsReceiptLine_tenant_isolation_placeholder" ON "GoodsReceiptLine";
CREATE POLICY "GoodsReceiptLine_tenant_isolation_placeholder" ON "GoodsReceiptLine" USING (true) WITH CHECK (true);

ALTER TABLE "GoogleReview" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "GoogleReview_tenant_isolation_placeholder" ON "GoogleReview";
CREATE POLICY "GoogleReview_tenant_isolation_placeholder" ON "GoogleReview" USING (true) WITH CHECK (true);

ALTER TABLE "JobCard" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCard_tenant_isolation_placeholder" ON "JobCard";
CREATE POLICY "JobCard_tenant_isolation_placeholder" ON "JobCard" USING (true) WITH CHECK (true);

ALTER TABLE "JobCardApproval" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardApproval_tenant_isolation_placeholder" ON "JobCardApproval";
CREATE POLICY "JobCardApproval_tenant_isolation_placeholder" ON "JobCardApproval" USING (true) WITH CHECK (true);

ALTER TABLE "JobCardInspectionItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardInspectionItem_tenant_isolation_placeholder" ON "JobCardInspectionItem";
CREATE POLICY "JobCardInspectionItem_tenant_isolation_placeholder" ON "JobCardInspectionItem" USING (true) WITH CHECK (true);

ALTER TABLE "JobCardItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardItem_tenant_isolation_placeholder" ON "JobCardItem";
CREATE POLICY "JobCardItem_tenant_isolation_placeholder" ON "JobCardItem" USING (true) WITH CHECK (true);

ALTER TABLE "JobCardTimeEntry" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JobCardTimeEntry_tenant_isolation_placeholder" ON "JobCardTimeEntry";
CREATE POLICY "JobCardTimeEntry_tenant_isolation_placeholder" ON "JobCardTimeEntry" USING (true) WITH CHECK (true);

ALTER TABLE "Journey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Journey_tenant_isolation_placeholder" ON "Journey";
CREATE POLICY "Journey_tenant_isolation_placeholder" ON "Journey" USING (true) WITH CHECK (true);

ALTER TABLE "JourneyEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyEvent_tenant_isolation_placeholder" ON "JourneyEvent";
CREATE POLICY "JourneyEvent_tenant_isolation_placeholder" ON "JourneyEvent" USING (true) WITH CHECK (true);

ALTER TABLE "JourneyRun" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyRun_tenant_isolation_placeholder" ON "JourneyRun";
CREATE POLICY "JourneyRun_tenant_isolation_placeholder" ON "JourneyRun" USING (true) WITH CHECK (true);

ALTER TABLE "JourneyStepLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyStepLog_tenant_isolation_placeholder" ON "JourneyStepLog";
CREATE POLICY "JourneyStepLog_tenant_isolation_placeholder" ON "JourneyStepLog" USING (true) WITH CHECK (true);

ALTER TABLE "JourneyVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "JourneyVersion_tenant_isolation_placeholder" ON "JourneyVersion";
CREATE POLICY "JourneyVersion_tenant_isolation_placeholder" ON "JourneyVersion" USING (true) WITH CHECK (true);

ALTER TABLE "Lead" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Lead_tenant_isolation_placeholder" ON "Lead";
CREATE POLICY "Lead_tenant_isolation_placeholder" ON "Lead" USING (true) WITH CHECK (true);

ALTER TABLE "LibraryDocument" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LibraryDocument_tenant_isolation_placeholder" ON "LibraryDocument";
CREATE POLICY "LibraryDocument_tenant_isolation_placeholder" ON "LibraryDocument" USING (true) WITH CHECK (true);

ALTER TABLE "LibraryVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LibraryVersion_tenant_isolation_placeholder" ON "LibraryVersion";
CREATE POLICY "LibraryVersion_tenant_isolation_placeholder" ON "LibraryVersion" USING (true) WITH CHECK (true);

ALTER TABLE "MarketingAudienceVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingAudienceVersion_tenant_isolation_placeholder" ON "MarketingAudienceVersion";
CREATE POLICY "MarketingAudienceVersion_tenant_isolation_placeholder" ON "MarketingAudienceVersion" USING (true) WITH CHECK (true);

ALTER TABLE "MarketingCampaignEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingCampaignEvent_tenant_isolation_placeholder" ON "MarketingCampaignEvent";
CREATE POLICY "MarketingCampaignEvent_tenant_isolation_placeholder" ON "MarketingCampaignEvent" USING (true) WITH CHECK (true);

ALTER TABLE "MarketingTemplateVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingTemplateVersion_tenant_isolation_placeholder" ON "MarketingTemplateVersion";
CREATE POLICY "MarketingTemplateVersion_tenant_isolation_placeholder" ON "MarketingTemplateVersion" USING (true) WITH CHECK (true);

ALTER TABLE "MarketingTouch" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MarketingTouch_tenant_isolation_placeholder" ON "MarketingTouch";
CREATE POLICY "MarketingTouch_tenant_isolation_placeholder" ON "MarketingTouch" USING (true) WITH CHECK (true);

ALTER TABLE "MileageLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "MileageLog_tenant_isolation_placeholder" ON "MileageLog";
CREATE POLICY "MileageLog_tenant_isolation_placeholder" ON "MileageLog" USING (true) WITH CHECK (true);

ALTER TABLE "Part" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Part_tenant_isolation_placeholder" ON "Part";
CREATE POLICY "Part_tenant_isolation_placeholder" ON "Part" USING (true) WITH CHECK (true);

ALTER TABLE "PartReservation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PartReservation_tenant_isolation_placeholder" ON "PartReservation";
CREATE POLICY "PartReservation_tenant_isolation_placeholder" ON "PartReservation" USING (true) WITH CHECK (true);

ALTER TABLE "PipelineStage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PipelineStage_tenant_isolation_placeholder" ON "PipelineStage";
CREATE POLICY "PipelineStage_tenant_isolation_placeholder" ON "PipelineStage" USING (true) WITH CHECK (true);

ALTER TABLE "PortalAccessGrant" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalAccessGrant_tenant_isolation_placeholder" ON "PortalAccessGrant";
CREATE POLICY "PortalAccessGrant_tenant_isolation_placeholder" ON "PortalAccessGrant" USING (true) WITH CHECK (true);

ALTER TABLE "PortalNotification" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalNotification_tenant_isolation_placeholder" ON "PortalNotification";
CREATE POLICY "PortalNotification_tenant_isolation_placeholder" ON "PortalNotification" USING (true) WITH CHECK (true);

ALTER TABLE "PortalPreference" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalPreference_tenant_isolation_placeholder" ON "PortalPreference";
CREATE POLICY "PortalPreference_tenant_isolation_placeholder" ON "PortalPreference" USING (true) WITH CHECK (true);

ALTER TABLE "PortalProfileChangeRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalProfileChangeRequest_tenant_isolation_placeholder" ON "PortalProfileChangeRequest";
CREATE POLICY "PortalProfileChangeRequest_tenant_isolation_placeholder" ON "PortalProfileChangeRequest" USING (true) WITH CHECK (true);

ALTER TABLE "PortalUpload" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PortalUpload_tenant_isolation_placeholder" ON "PortalUpload";
CREATE POLICY "PortalUpload_tenant_isolation_placeholder" ON "PortalUpload" USING (true) WITH CHECK (true);

ALTER TABLE "Product" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Product_tenant_isolation_placeholder" ON "Product";
CREATE POLICY "Product_tenant_isolation_placeholder" ON "Product" USING (true) WITH CHECK (true);

ALTER TABLE "ProductColor" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ProductColor_tenant_isolation_placeholder" ON "ProductColor";
CREATE POLICY "ProductColor_tenant_isolation_placeholder" ON "ProductColor" USING (true) WITH CHECK (true);

ALTER TABLE "PurchaseOrder" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PurchaseOrder_tenant_isolation_placeholder" ON "PurchaseOrder";
CREATE POLICY "PurchaseOrder_tenant_isolation_placeholder" ON "PurchaseOrder" USING (true) WITH CHECK (true);

ALTER TABLE "PurchaseOrderLine" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "PurchaseOrderLine_tenant_isolation_placeholder" ON "PurchaseOrderLine";
CREATE POLICY "PurchaseOrderLine_tenant_isolation_placeholder" ON "PurchaseOrderLine" USING (true) WITH CHECK (true);

ALTER TABLE "Quote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Quote_tenant_isolation_placeholder" ON "Quote";
CREATE POLICY "Quote_tenant_isolation_placeholder" ON "Quote" USING (true) WITH CHECK (true);

ALTER TABLE "QuoteFee" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QuoteFee_tenant_isolation_placeholder" ON "QuoteFee";
CREATE POLICY "QuoteFee_tenant_isolation_placeholder" ON "QuoteFee" USING (true) WITH CHECK (true);

ALTER TABLE "QuoteItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "QuoteItem_tenant_isolation_placeholder" ON "QuoteItem";
CREATE POLICY "QuoteItem_tenant_isolation_placeholder" ON "QuoteItem" USING (true) WITH CHECK (true);

ALTER TABLE "Recall" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Recall_tenant_isolation_placeholder" ON "Recall";
CREATE POLICY "Recall_tenant_isolation_placeholder" ON "Recall" USING (true) WITH CHECK (true);

ALTER TABLE "Referral" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Referral_tenant_isolation_placeholder" ON "Referral";
CREATE POLICY "Referral_tenant_isolation_placeholder" ON "Referral" USING (true) WITH CHECK (true);

ALTER TABLE "ResearchNote" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ResearchNote_tenant_isolation_placeholder" ON "ResearchNote";
CREATE POLICY "ResearchNote_tenant_isolation_placeholder" ON "ResearchNote" USING (true) WITH CHECK (true);

ALTER TABLE "ReusableBlock" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ReusableBlock_tenant_isolation_placeholder" ON "ReusableBlock";
CREATE POLICY "ReusableBlock_tenant_isolation_placeholder" ON "ReusableBlock" USING (true) WITH CHECK (true);

ALTER TABLE "Role" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Role_tenant_isolation_placeholder" ON "Role";
CREATE POLICY "Role_tenant_isolation_placeholder" ON "Role" USING (true) WITH CHECK (true);

ALTER TABLE "RolePermission" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "RolePermission_tenant_isolation_placeholder" ON "RolePermission";
CREATE POLICY "RolePermission_tenant_isolation_placeholder" ON "RolePermission" USING (true) WITH CHECK (true);

ALTER TABLE "SalesPipeline" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SalesPipeline_tenant_isolation_placeholder" ON "SalesPipeline";
CREATE POLICY "SalesPipeline_tenant_isolation_placeholder" ON "SalesPipeline" USING (true) WITH CHECK (true);

ALTER TABLE "SavedView" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SavedView_tenant_isolation_placeholder" ON "SavedView";
CREATE POLICY "SavedView_tenant_isolation_placeholder" ON "SavedView" USING (true) WITH CHECK (true);

ALTER TABLE "Segment" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Segment_tenant_isolation_placeholder" ON "Segment";
CREATE POLICY "Segment_tenant_isolation_placeholder" ON "Segment" USING (true) WITH CHECK (true);

ALTER TABLE "ServicePackage" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServicePackage_tenant_isolation_placeholder" ON "ServicePackage";
CREATE POLICY "ServicePackage_tenant_isolation_placeholder" ON "ServicePackage" USING (true) WITH CHECK (true);

ALTER TABLE "ServicePackageItem" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServicePackageItem_tenant_isolation_placeholder" ON "ServicePackageItem";
CREATE POLICY "ServicePackageItem_tenant_isolation_placeholder" ON "ServicePackageItem" USING (true) WITH CHECK (true);

ALTER TABLE "ServiceRecord" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServiceRecord_tenant_isolation_placeholder" ON "ServiceRecord";
CREATE POLICY "ServiceRecord_tenant_isolation_placeholder" ON "ServiceRecord" USING (true) WITH CHECK (true);

ALTER TABLE "ServiceReminderLog" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ServiceReminderLog_tenant_isolation_placeholder" ON "ServiceReminderLog";
CREATE POLICY "ServiceReminderLog_tenant_isolation_placeholder" ON "ServiceReminderLog" USING (true) WITH CHECK (true);

ALTER TABLE "SignWorkflow" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignWorkflow_tenant_isolation_placeholder" ON "SignWorkflow";
CREATE POLICY "SignWorkflow_tenant_isolation_placeholder" ON "SignWorkflow" USING (true) WITH CHECK (true);

ALTER TABLE "SignatureEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureEvent_tenant_isolation_placeholder" ON "SignatureEvent";
CREATE POLICY "SignatureEvent_tenant_isolation_placeholder" ON "SignatureEvent" USING (true) WITH CHECK (true);

ALTER TABLE "SignatureField" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureField_tenant_isolation_placeholder" ON "SignatureField";
CREATE POLICY "SignatureField_tenant_isolation_placeholder" ON "SignatureField" USING (true) WITH CHECK (true);

ALTER TABLE "SignatureFieldResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureFieldResponse_tenant_isolation_placeholder" ON "SignatureFieldResponse";
CREATE POLICY "SignatureFieldResponse_tenant_isolation_placeholder" ON "SignatureFieldResponse" USING (true) WITH CHECK (true);

ALTER TABLE "SignatureRecipient" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureRecipient_tenant_isolation_placeholder" ON "SignatureRecipient";
CREATE POLICY "SignatureRecipient_tenant_isolation_placeholder" ON "SignatureRecipient" USING (true) WITH CHECK (true);

ALTER TABLE "SignatureRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureRequest_tenant_isolation_placeholder" ON "SignatureRequest";
CREATE POLICY "SignatureRequest_tenant_isolation_placeholder" ON "SignatureRequest" USING (true) WITH CHECK (true);

ALTER TABLE "StockEvent" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockEvent_tenant_isolation_placeholder" ON "StockEvent";
CREATE POLICY "StockEvent_tenant_isolation_placeholder" ON "StockEvent" USING (true) WITH CHECK (true);

ALTER TABLE "StockReservation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockReservation_tenant_isolation_placeholder" ON "StockReservation";
CREATE POLICY "StockReservation_tenant_isolation_placeholder" ON "StockReservation" USING (true) WITH CHECK (true);

ALTER TABLE "StockUnit" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "StockUnit_tenant_isolation_placeholder" ON "StockUnit";
CREATE POLICY "StockUnit_tenant_isolation_placeholder" ON "StockUnit" USING (true) WITH CHECK (true);

ALTER TABLE "SupportMailbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SupportMailbox_tenant_isolation_placeholder" ON "SupportMailbox";
CREATE POLICY "SupportMailbox_tenant_isolation_placeholder" ON "SupportMailbox" USING (true) WITH CHECK (true);

ALTER TABLE "SupportTag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SupportTag_tenant_isolation_placeholder" ON "SupportTag";
CREATE POLICY "SupportTag_tenant_isolation_placeholder" ON "SupportTag" USING (true) WITH CHECK (true);

ALTER TABLE "Survey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Survey_tenant_isolation_placeholder" ON "Survey";
CREATE POLICY "Survey_tenant_isolation_placeholder" ON "Survey" USING (true) WITH CHECK (true);

ALTER TABLE "SurveyDistribution" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyDistribution_tenant_isolation_placeholder" ON "SurveyDistribution";
CREATE POLICY "SurveyDistribution_tenant_isolation_placeholder" ON "SurveyDistribution" USING (true) WITH CHECK (true);

ALTER TABLE "SurveyFollowUp" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyFollowUp_tenant_isolation_placeholder" ON "SurveyFollowUp";
CREATE POLICY "SurveyFollowUp_tenant_isolation_placeholder" ON "SurveyFollowUp" USING (true) WITH CHECK (true);

ALTER TABLE "SurveyResponse" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyResponse_tenant_isolation_placeholder" ON "SurveyResponse";
CREATE POLICY "SurveyResponse_tenant_isolation_placeholder" ON "SurveyResponse" USING (true) WITH CHECK (true);

ALTER TABLE "SurveyVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SurveyVersion_tenant_isolation_placeholder" ON "SurveyVersion";
CREATE POLICY "SurveyVersion_tenant_isolation_placeholder" ON "SurveyVersion" USING (true) WITH CHECK (true);

ALTER TABLE "Tag" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Tag_tenant_isolation_placeholder" ON "Tag";
CREATE POLICY "Tag_tenant_isolation_placeholder" ON "Tag" USING (true) WITH CHECK (true);

ALTER TABLE "Target" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Target_tenant_isolation_placeholder" ON "Target";
CREATE POLICY "Target_tenant_isolation_placeholder" ON "Target" USING (true) WITH CHECK (true);

ALTER TABLE "Team" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Team_tenant_isolation_placeholder" ON "Team";
CREATE POLICY "Team_tenant_isolation_placeholder" ON "Team" USING (true) WITH CHECK (true);

ALTER TABLE "TeamMember" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TeamMember_tenant_isolation_placeholder" ON "TeamMember";
CREATE POLICY "TeamMember_tenant_isolation_placeholder" ON "TeamMember" USING (true) WITH CHECK (true);

ALTER TABLE "TenantApiKey" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantApiKey_tenant_isolation_placeholder" ON "TenantApiKey";
CREATE POLICY "TenantApiKey_tenant_isolation_placeholder" ON "TenantApiKey" USING (true) WITH CHECK (true);

ALTER TABLE "TenantIntegrationCredential" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantIntegrationCredential_tenant_isolation_placeholder" ON "TenantIntegrationCredential";
CREATE POLICY "TenantIntegrationCredential_tenant_isolation_placeholder" ON "TenantIntegrationCredential" USING (true) WITH CHECK (true);

ALTER TABLE "TestDriveAsset" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TestDriveAsset_tenant_isolation_placeholder" ON "TestDriveAsset";
CREATE POLICY "TestDriveAsset_tenant_isolation_placeholder" ON "TestDriveAsset" USING (true) WITH CHECK (true);

ALTER TABLE "TestDriveBooking" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TestDriveBooking_tenant_isolation_placeholder" ON "TestDriveBooking";
CREATE POLICY "TestDriveBooking_tenant_isolation_placeholder" ON "TestDriveBooking" USING (true) WITH CHECK (true);

ALTER TABLE "TimelinePin" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TimelinePin_tenant_isolation_placeholder" ON "TimelinePin";
CREATE POLICY "TimelinePin_tenant_isolation_placeholder" ON "TimelinePin" USING (true) WITH CHECK (true);

ALTER TABLE "UserRole" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "UserRole_tenant_isolation_placeholder" ON "UserRole";
CREATE POLICY "UserRole_tenant_isolation_placeholder" ON "UserRole" USING (true) WITH CHECK (true);

ALTER TABLE "UserSession" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "UserSession_tenant_isolation_placeholder" ON "UserSession";
CREATE POLICY "UserSession_tenant_isolation_placeholder" ON "UserSession" USING (true) WITH CHECK (true);

ALTER TABLE "Vehicle" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Vehicle_tenant_isolation_placeholder" ON "Vehicle";
CREATE POLICY "Vehicle_tenant_isolation_placeholder" ON "Vehicle" USING (true) WITH CHECK (true);

ALTER TABLE "WarrantyClaim" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WarrantyClaim_tenant_isolation_placeholder" ON "WarrantyClaim";
CREATE POLICY "WarrantyClaim_tenant_isolation_placeholder" ON "WarrantyClaim" USING (true) WITH CHECK (true);

ALTER TABLE "WorkshopBay" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "WorkshopBay_tenant_isolation_placeholder" ON "WorkshopBay";
CREATE POLICY "WorkshopBay_tenant_isolation_placeholder" ON "WorkshopBay" USING (true) WITH CHECK (true);

