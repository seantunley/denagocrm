-- =============================================================================
-- COMPOSITE TENANT FOREIGN KEYS MIGRATION
-- =============================================================================
-- NOT VALID means existing rows are NOT checked when the constraint is added
-- (safe for tables that already have backfilled data). Run
--   VALIDATE CONSTRAINT "<name>" on "<table>"
-- later (in a maintenance window) to verify historical rows.
--
-- These constraints prevent cross-tenant parent/child references for any
-- row that is inserted or updated after this migration runs.
--
-- A composite unique index on the parent ("tenantId", "id") is required before
-- PostgreSQL will allow a composite FK to reference it — that is why Step 1
-- creates those indexes first.
--
-- Optional FK columns (nullable fkField): NULL satisfies a FK trivially in SQL
-- so NOT VALID + nullable fkField is always correct.
-- =============================================================================

-- =============================================================================
-- STEP 1: Composite unique indexes on parent tables
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS "Contact_tenantId_id_key"          ON "Contact"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Lead_tenantId_id_key"             ON "Lead"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Product_tenantId_id_key"          ON "Product"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrder_tenantId_id_key"    ON "PurchaseOrder"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "StockUnit_tenantId_id_key"        ON "StockUnit"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Quote_tenantId_id_key"            ON "Quote"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "GoodsReceipt_tenantId_id_key"     ON "GoodsReceipt"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseOrderLine_tenantId_id_key" ON "PurchaseOrderLine"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_tenantId_id_key"          ON "Vehicle"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "JobCard_tenantId_id_key"          ON "JobCard"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Part_tenantId_id_key"             ON "Part"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Fleet_tenantId_id_key"            ON "Fleet"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "WorkshopBay_tenantId_id_key"      ON "WorkshopBay"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "ServicePackage_tenantId_id_key"   ON "ServicePackage"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "LibraryDocument_tenantId_id_key"  ON "LibraryDocument"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_tenantId_id_key"         ON "Campaign"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_tenantId_id_key"     ON "Conversation"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRequest_tenantId_id_key"  ON "SignatureRequest"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRecipient_tenantId_id_key" ON "SignatureRecipient"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureField_tenantId_id_key"   ON "SignatureField"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "DocBuilderTemplate_tenantId_id_key" ON "DocBuilderTemplate"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomDocTemplate_tenantId_id_key" ON "CustomDocTemplate"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomerCase_tenantId_id_key"     ON "CustomerCase"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SupportMailbox_tenantId_id_key"   ON "SupportMailbox"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SupportTag_tenantId_id_key"       ON "SupportTag"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Competitor_tenantId_id_key"       ON "Competitor"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CompetitorSource_tenantId_id_key" ON "CompetitorSource"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "CustomFieldDef_tenantId_id_key"   ON "CustomFieldDef"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "Survey_tenantId_id_key"           ON "Survey"("tenantId", "id");

-- =============================================================================
-- STEP 2: Composite FK constraints (NOT VALID, idempotent via DO blocks)
-- =============================================================================

-- LibraryVersion → LibraryDocument
DO $$ BEGIN
  ALTER TABLE "LibraryVersion" ADD CONSTRAINT "LibraryVersion_tenantId_documentId_fkey"
    FOREIGN KEY ("tenantId", "documentId") REFERENCES "LibraryDocument"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockUnit → Product
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockUnit → PurchaseOrder
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockReservation → StockUnit
DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_tenantId_stockUnitId_fkey"
    FOREIGN KEY ("tenantId", "stockUnitId") REFERENCES "StockUnit"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockReservation → Lead
DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockReservation → Quote
DO $$ BEGIN
  ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockEvent → StockUnit
DO $$ BEGIN
  ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_stockUnitId_fkey"
    FOREIGN KEY ("tenantId", "stockUnitId") REFERENCES "StockUnit"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockEvent → PurchaseOrder
DO $$ BEGIN
  ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PurchaseOrderLine → PurchaseOrder
DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PurchaseOrderLine → Product
DO $$ BEGIN
  ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GoodsReceipt → PurchaseOrder
DO $$ BEGIN
  ALTER TABLE "GoodsReceipt" ADD CONSTRAINT "GoodsReceipt_tenantId_purchaseOrderId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "PurchaseOrder"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GoodsReceiptLine → GoodsReceipt
DO $$ BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_goodsReceiptId_fkey"
    FOREIGN KEY ("tenantId", "goodsReceiptId") REFERENCES "GoodsReceipt"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GoodsReceiptLine → PurchaseOrderLine
DO $$ BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_purchaseOrderLineId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GoodsReceiptLine → StockUnit
DO $$ BEGIN
  ALTER TABLE "GoodsReceiptLine" ADD CONSTRAINT "GoodsReceiptLine_tenantId_stockUnitId_fkey"
    FOREIGN KEY ("tenantId", "stockUnitId") REFERENCES "StockUnit"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ProductColor → Product
DO $$ BEGIN
  ALTER TABLE "ProductColor" ADD CONSTRAINT "ProductColor_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ConsentRecord → Contact
DO $$ BEGIN
  ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CampaignRecipient → Campaign
DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_tenantId_campaignId_fkey"
    FOREIGN KEY ("tenantId", "campaignId") REFERENCES "Campaign"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CampaignRecipient → Contact
DO $$ BEGIN
  ALTER TABLE "CampaignRecipient" ADD CONSTRAINT "CampaignRecipient_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ResearchNote → Lead
DO $$ BEGIN
  ALTER TABLE "ResearchNote" ADD CONSTRAINT "ResearchNote_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ResearchNote → Contact
DO $$ BEGIN
  ALTER TABLE "ResearchNote" ADD CONSTRAINT "ResearchNote_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Activity → Lead
DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Activity → Contact
DO $$ BEGIN
  ALTER TABLE "Activity" ADD CONSTRAINT "Activity_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- QuoteItem → Product
DO $$ BEGIN
  ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- QuoteItem → Quote
DO $$ BEGIN
  ALTER TABLE "QuoteItem" ADD CONSTRAINT "QuoteItem_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- QuoteFee → Quote
DO $$ BEGIN
  ALTER TABLE "QuoteFee" ADD CONSTRAINT "QuoteFee_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Communication → Conversation
DO $$ BEGIN
  ALTER TABLE "Communication" ADD CONSTRAINT "Communication_tenantId_conversationId_fkey"
    FOREIGN KEY ("tenantId", "conversationId") REFERENCES "Conversation"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Communication → Contact
DO $$ BEGIN
  ALTER TABLE "Communication" ADD CONSTRAINT "Communication_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Communication → Lead
DO $$ BEGIN
  ALTER TABLE "Communication" ADD CONSTRAINT "Communication_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Conversation → Contact
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Conversation → Lead
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Document → Contact
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Document → Vehicle
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Document → JobCard
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Vehicle → Contact
DO $$ BEGIN
  ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Vehicle → Product
DO $$ BEGIN
  ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Vehicle → Fleet
DO $$ BEGIN
  ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_tenantId_fleetId_fkey"
    FOREIGN KEY ("tenantId", "fleetId") REFERENCES "Fleet"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- WarrantyClaim → Vehicle
DO $$ BEGIN
  ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- BatteryCheck → Vehicle
DO $$ BEGIN
  ALTER TABLE "BatteryCheck" ADD CONSTRAINT "BatteryCheck_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- MileageLog → Vehicle
DO $$ BEGIN
  ALTER TABLE "MileageLog" ADD CONSTRAINT "MileageLog_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ServiceRecord → Vehicle
DO $$ BEGIN
  ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ServiceRecord → JobCard
DO $$ BEGIN
  ALTER TABLE "ServiceRecord" ADD CONSTRAINT "ServiceRecord_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCard → WorkshopBay
DO $$ BEGIN
  ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_tenantId_bayId_fkey"
    FOREIGN KEY ("tenantId", "bayId") REFERENCES "WorkshopBay"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCard → Vehicle
DO $$ BEGIN
  ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCard → Contact
DO $$ BEGIN
  ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCard → JobCard (comeback self-reference)
DO $$ BEGIN
  ALTER TABLE "JobCard" ADD CONSTRAINT "JobCard_tenantId_comebackOfId_fkey"
    FOREIGN KEY ("tenantId", "comebackOfId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PartReservation → Part
DO $$ BEGIN
  ALTER TABLE "PartReservation" ADD CONSTRAINT "PartReservation_tenantId_partId_fkey"
    FOREIGN KEY ("tenantId", "partId") REFERENCES "Part"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PartReservation → JobCard
DO $$ BEGIN
  ALTER TABLE "PartReservation" ADD CONSTRAINT "PartReservation_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ServicePackageItem → ServicePackage
DO $$ BEGIN
  ALTER TABLE "ServicePackageItem" ADD CONSTRAINT "ServicePackageItem_tenantId_packageId_fkey"
    FOREIGN KEY ("tenantId", "packageId") REFERENCES "ServicePackage"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCardInspectionItem → JobCard
DO $$ BEGIN
  ALTER TABLE "JobCardInspectionItem" ADD CONSTRAINT "JobCardInspectionItem_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCardApproval → JobCard
DO $$ BEGIN
  ALTER TABLE "JobCardApproval" ADD CONSTRAINT "JobCardApproval_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCardTimeEntry → JobCard
DO $$ BEGIN
  ALTER TABLE "JobCardTimeEntry" ADD CONSTRAINT "JobCardTimeEntry_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCardItem → JobCard
DO $$ BEGIN
  ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- JobCardItem → Part
DO $$ BEGIN
  ALTER TABLE "JobCardItem" ADD CONSTRAINT "JobCardItem_tenantId_partId_fkey"
    FOREIGN KEY ("tenantId", "partId") REFERENCES "Part"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral → Contact (referrer)
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_tenantId_referrerId_fkey"
    FOREIGN KEY ("tenantId", "referrerId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral → Lead
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Referral → Contact (referred contact)
DO $$ BEGIN
  ALTER TABLE "Referral" ADD CONSTRAINT "Referral_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DocBuilderVersion → DocBuilderTemplate
DO $$ BEGIN
  ALTER TABLE "DocBuilderVersion" ADD CONSTRAINT "DocBuilderVersion_tenantId_templateId_fkey"
    FOREIGN KEY ("tenantId", "templateId") REFERENCES "DocBuilderTemplate"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ApprovalStep → SignatureRequest
DO $$ BEGIN
  ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_tenantId_requestId_fkey"
    FOREIGN KEY ("tenantId", "requestId") REFERENCES "SignatureRequest"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureRecipient → SignatureRequest
DO $$ BEGIN
  ALTER TABLE "SignatureRecipient" ADD CONSTRAINT "SignatureRecipient_tenantId_requestId_fkey"
    FOREIGN KEY ("tenantId", "requestId") REFERENCES "SignatureRequest"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureField → SignatureRequest
DO $$ BEGIN
  ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_tenantId_requestId_fkey"
    FOREIGN KEY ("tenantId", "requestId") REFERENCES "SignatureRequest"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureField → SignatureRecipient
DO $$ BEGIN
  ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_tenantId_recipientId_fkey"
    FOREIGN KEY ("tenantId", "recipientId") REFERENCES "SignatureRecipient"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureFieldResponse → SignatureField
DO $$ BEGIN
  ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_tenantId_fieldId_fkey"
    FOREIGN KEY ("tenantId", "fieldId") REFERENCES "SignatureField"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureFieldResponse → SignatureRecipient
DO $$ BEGIN
  ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_tenantId_recipientId_fkey"
    FOREIGN KEY ("tenantId", "recipientId") REFERENCES "SignatureRecipient"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SignatureEvent → SignatureRequest
DO $$ BEGIN
  ALTER TABLE "SignatureEvent" ADD CONSTRAINT "SignatureEvent_tenantId_requestId_fkey"
    FOREIGN KEY ("tenantId", "requestId") REFERENCES "SignatureRequest"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomDocVersion → CustomDocTemplate
DO $$ BEGIN
  ALTER TABLE "CustomDocVersion" ADD CONSTRAINT "CustomDocVersion_tenantId_templateId_fkey"
    FOREIGN KEY ("tenantId", "templateId") REFERENCES "CustomDocTemplate"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DocInstance → CustomDocTemplate
DO $$ BEGIN
  ALTER TABLE "DocInstance" ADD CONSTRAINT "DocInstance_tenantId_templateId_fkey"
    FOREIGN KEY ("tenantId", "templateId") REFERENCES "CustomDocTemplate"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomerCaseMessage → CustomerCase
DO $$ BEGIN
  ALTER TABLE "CustomerCaseMessage" ADD CONSTRAINT "CustomerCaseMessage_tenantId_caseId_fkey"
    FOREIGN KEY ("tenantId", "caseId") REFERENCES "CustomerCase"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomerCaseTag → CustomerCase
DO $$ BEGIN
  ALTER TABLE "CustomerCaseTag" ADD CONSTRAINT "CustomerCaseTag_tenantId_caseId_fkey"
    FOREIGN KEY ("tenantId", "caseId") REFERENCES "CustomerCase"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomerCaseTag → SupportTag
DO $$ BEGIN
  ALTER TABLE "CustomerCaseTag" ADD CONSTRAINT "CustomerCaseTag_tenantId_tagId_fkey"
    FOREIGN KEY ("tenantId", "tagId") REFERENCES "SupportTag"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CannedReply → SupportMailbox
DO $$ BEGIN
  ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_tenantId_mailboxId_fkey"
    FOREIGN KEY ("tenantId", "mailboxId") REFERENCES "SupportMailbox"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorSource → Competitor
DO $$ BEGIN
  ALTER TABLE "CompetitorSource" ADD CONSTRAINT "CompetitorSource_tenantId_competitorId_fkey"
    FOREIGN KEY ("tenantId", "competitorId") REFERENCES "Competitor"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorSnapshot → Competitor
DO $$ BEGIN
  ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_tenantId_competitorId_fkey"
    FOREIGN KEY ("tenantId", "competitorId") REFERENCES "Competitor"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorSnapshot → CompetitorSource
DO $$ BEGIN
  ALTER TABLE "CompetitorSnapshot" ADD CONSTRAINT "CompetitorSnapshot_tenantId_sourceId_fkey"
    FOREIGN KEY ("tenantId", "sourceId") REFERENCES "CompetitorSource"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorChange → Competitor
DO $$ BEGIN
  ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_tenantId_competitorId_fkey"
    FOREIGN KEY ("tenantId", "competitorId") REFERENCES "Competitor"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorChange → CompetitorSource
DO $$ BEGIN
  ALTER TABLE "CompetitorChange" ADD CONSTRAINT "CompetitorChange_tenantId_sourceId_fkey"
    FOREIGN KEY ("tenantId", "sourceId") REFERENCES "CompetitorSource"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CompetitorBrief → Competitor
DO $$ BEGIN
  ALTER TABLE "CompetitorBrief" ADD CONSTRAINT "CompetitorBrief_tenantId_competitorId_fkey"
    FOREIGN KEY ("tenantId", "competitorId") REFERENCES "Competitor"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomFieldValue → CustomFieldDef
DO $$ BEGIN
  ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_tenantId_defId_fkey"
    FOREIGN KEY ("tenantId", "defId") REFERENCES "CustomFieldDef"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- SurveyResponse → Survey
DO $$ BEGIN
  ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_surveyId_fkey"
    FOREIGN KEY ("tenantId", "surveyId") REFERENCES "Survey"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
