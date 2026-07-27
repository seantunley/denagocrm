-- Validate all composite tenant FK constraints added NOT VALID in:
--   20260727140000_composite_tenant_fks (78 constraints)
--   20260727150000_composite_tenant_fks_supplement (11 constraints)
--   20260727160000_composite_tenant_fks_loose_pointers (41 constraints)
--
-- VALIDATE CONSTRAINT acquires SHARE UPDATE EXCLUSIVE — allows concurrent
-- reads and writes, only blocks other schema changes. Safe in production.
-- Fails if any existing row violates the constraint (the point: surface violations
-- before enforcement is flipped on).

-- ── From 20260727140000 ──────────────────────────────────────────────────────

ALTER TABLE "LibraryVersion"          VALIDATE CONSTRAINT "LibraryVersion_tenantId_documentId_fkey";

ALTER TABLE "StockUnit"               VALIDATE CONSTRAINT "StockUnit_tenantId_productId_fkey";
ALTER TABLE "StockUnit"               VALIDATE CONSTRAINT "StockUnit_tenantId_purchaseOrderId_fkey";

ALTER TABLE "StockReservation"        VALIDATE CONSTRAINT "StockReservation_tenantId_stockUnitId_fkey";
ALTER TABLE "StockReservation"        VALIDATE CONSTRAINT "StockReservation_tenantId_leadId_fkey";
ALTER TABLE "StockReservation"        VALIDATE CONSTRAINT "StockReservation_tenantId_quoteId_fkey";

ALTER TABLE "StockEvent"              VALIDATE CONSTRAINT "StockEvent_tenantId_stockUnitId_fkey";
ALTER TABLE "StockEvent"              VALIDATE CONSTRAINT "StockEvent_tenantId_purchaseOrderId_fkey";

ALTER TABLE "PurchaseOrderLine"       VALIDATE CONSTRAINT "PurchaseOrderLine_tenantId_purchaseOrderId_fkey";
ALTER TABLE "PurchaseOrderLine"       VALIDATE CONSTRAINT "PurchaseOrderLine_tenantId_productId_fkey";

ALTER TABLE "GoodsReceipt"            VALIDATE CONSTRAINT "GoodsReceipt_tenantId_purchaseOrderId_fkey";

ALTER TABLE "GoodsReceiptLine"        VALIDATE CONSTRAINT "GoodsReceiptLine_tenantId_goodsReceiptId_fkey";
ALTER TABLE "GoodsReceiptLine"        VALIDATE CONSTRAINT "GoodsReceiptLine_tenantId_purchaseOrderLineId_fkey";
ALTER TABLE "GoodsReceiptLine"        VALIDATE CONSTRAINT "GoodsReceiptLine_tenantId_stockUnitId_fkey";

ALTER TABLE "ProductColor"            VALIDATE CONSTRAINT "ProductColor_tenantId_productId_fkey";

ALTER TABLE "ConsentRecord"           VALIDATE CONSTRAINT "ConsentRecord_tenantId_contactId_fkey";

ALTER TABLE "CampaignRecipient"       VALIDATE CONSTRAINT "CampaignRecipient_tenantId_campaignId_fkey";
ALTER TABLE "CampaignRecipient"       VALIDATE CONSTRAINT "CampaignRecipient_tenantId_contactId_fkey";

ALTER TABLE "ResearchNote"            VALIDATE CONSTRAINT "ResearchNote_tenantId_leadId_fkey";
ALTER TABLE "ResearchNote"            VALIDATE CONSTRAINT "ResearchNote_tenantId_contactId_fkey";

ALTER TABLE "Activity"                VALIDATE CONSTRAINT "Activity_tenantId_leadId_fkey";
ALTER TABLE "Activity"                VALIDATE CONSTRAINT "Activity_tenantId_contactId_fkey";

ALTER TABLE "QuoteItem"               VALIDATE CONSTRAINT "QuoteItem_tenantId_productId_fkey";
ALTER TABLE "QuoteItem"               VALIDATE CONSTRAINT "QuoteItem_tenantId_quoteId_fkey";

ALTER TABLE "QuoteFee"                VALIDATE CONSTRAINT "QuoteFee_tenantId_quoteId_fkey";

ALTER TABLE "Communication"           VALIDATE CONSTRAINT "Communication_tenantId_conversationId_fkey";
ALTER TABLE "Communication"           VALIDATE CONSTRAINT "Communication_tenantId_contactId_fkey";
ALTER TABLE "Communication"           VALIDATE CONSTRAINT "Communication_tenantId_leadId_fkey";

ALTER TABLE "Conversation"            VALIDATE CONSTRAINT "Conversation_tenantId_contactId_fkey";
ALTER TABLE "Conversation"            VALIDATE CONSTRAINT "Conversation_tenantId_leadId_fkey";

ALTER TABLE "Document"                VALIDATE CONSTRAINT "Document_tenantId_contactId_fkey";
ALTER TABLE "Document"                VALIDATE CONSTRAINT "Document_tenantId_vehicleId_fkey";
ALTER TABLE "Document"                VALIDATE CONSTRAINT "Document_tenantId_jobCardId_fkey";

ALTER TABLE "Vehicle"                 VALIDATE CONSTRAINT "Vehicle_tenantId_contactId_fkey";
ALTER TABLE "Vehicle"                 VALIDATE CONSTRAINT "Vehicle_tenantId_productId_fkey";
ALTER TABLE "Vehicle"                 VALIDATE CONSTRAINT "Vehicle_tenantId_fleetId_fkey";

ALTER TABLE "WarrantyClaim"           VALIDATE CONSTRAINT "WarrantyClaim_tenantId_vehicleId_fkey";

ALTER TABLE "BatteryCheck"            VALIDATE CONSTRAINT "BatteryCheck_tenantId_vehicleId_fkey";

ALTER TABLE "MileageLog"              VALIDATE CONSTRAINT "MileageLog_tenantId_vehicleId_fkey";

ALTER TABLE "ServiceRecord"           VALIDATE CONSTRAINT "ServiceRecord_tenantId_vehicleId_fkey";
ALTER TABLE "ServiceRecord"           VALIDATE CONSTRAINT "ServiceRecord_tenantId_jobCardId_fkey";

ALTER TABLE "JobCard"                 VALIDATE CONSTRAINT "JobCard_tenantId_bayId_fkey";
ALTER TABLE "JobCard"                 VALIDATE CONSTRAINT "JobCard_tenantId_vehicleId_fkey";
ALTER TABLE "JobCard"                 VALIDATE CONSTRAINT "JobCard_tenantId_contactId_fkey";
ALTER TABLE "JobCard"                 VALIDATE CONSTRAINT "JobCard_tenantId_comebackOfId_fkey";

ALTER TABLE "PartReservation"         VALIDATE CONSTRAINT "PartReservation_tenantId_partId_fkey";
ALTER TABLE "PartReservation"         VALIDATE CONSTRAINT "PartReservation_tenantId_jobCardId_fkey";

ALTER TABLE "ServicePackageItem"      VALIDATE CONSTRAINT "ServicePackageItem_tenantId_packageId_fkey";

ALTER TABLE "JobCardInspectionItem"   VALIDATE CONSTRAINT "JobCardInspectionItem_tenantId_jobCardId_fkey";

ALTER TABLE "JobCardApproval"         VALIDATE CONSTRAINT "JobCardApproval_tenantId_jobCardId_fkey";

ALTER TABLE "JobCardTimeEntry"        VALIDATE CONSTRAINT "JobCardTimeEntry_tenantId_jobCardId_fkey";

ALTER TABLE "JobCardItem"             VALIDATE CONSTRAINT "JobCardItem_tenantId_jobCardId_fkey";
ALTER TABLE "JobCardItem"             VALIDATE CONSTRAINT "JobCardItem_tenantId_partId_fkey";

ALTER TABLE "Referral"                VALIDATE CONSTRAINT "Referral_tenantId_referrerId_fkey";
ALTER TABLE "Referral"                VALIDATE CONSTRAINT "Referral_tenantId_leadId_fkey";
ALTER TABLE "Referral"                VALIDATE CONSTRAINT "Referral_tenantId_contactId_fkey";

ALTER TABLE "DocBuilderVersion"       VALIDATE CONSTRAINT "DocBuilderVersion_tenantId_templateId_fkey";

ALTER TABLE "ApprovalStep"            VALIDATE CONSTRAINT "ApprovalStep_tenantId_requestId_fkey";

ALTER TABLE "SignatureRecipient"      VALIDATE CONSTRAINT "SignatureRecipient_tenantId_requestId_fkey";

ALTER TABLE "SignatureField"          VALIDATE CONSTRAINT "SignatureField_tenantId_requestId_fkey";
ALTER TABLE "SignatureField"          VALIDATE CONSTRAINT "SignatureField_tenantId_recipientId_fkey";

ALTER TABLE "SignatureFieldResponse"  VALIDATE CONSTRAINT "SignatureFieldResponse_tenantId_fieldId_fkey";
ALTER TABLE "SignatureFieldResponse"  VALIDATE CONSTRAINT "SignatureFieldResponse_tenantId_recipientId_fkey";

ALTER TABLE "SignatureEvent"          VALIDATE CONSTRAINT "SignatureEvent_tenantId_requestId_fkey";

ALTER TABLE "CustomDocVersion"        VALIDATE CONSTRAINT "CustomDocVersion_tenantId_templateId_fkey";

ALTER TABLE "DocInstance"             VALIDATE CONSTRAINT "DocInstance_tenantId_templateId_fkey";

ALTER TABLE "CustomerCaseMessage"     VALIDATE CONSTRAINT "CustomerCaseMessage_tenantId_caseId_fkey";

ALTER TABLE "CustomerCaseTag"         VALIDATE CONSTRAINT "CustomerCaseTag_tenantId_caseId_fkey";
ALTER TABLE "CustomerCaseTag"         VALIDATE CONSTRAINT "CustomerCaseTag_tenantId_tagId_fkey";

ALTER TABLE "CannedReply"             VALIDATE CONSTRAINT "CannedReply_tenantId_mailboxId_fkey";

ALTER TABLE "CompetitorSource"        VALIDATE CONSTRAINT "CompetitorSource_tenantId_competitorId_fkey";

ALTER TABLE "CompetitorSnapshot"      VALIDATE CONSTRAINT "CompetitorSnapshot_tenantId_competitorId_fkey";
ALTER TABLE "CompetitorSnapshot"      VALIDATE CONSTRAINT "CompetitorSnapshot_tenantId_sourceId_fkey";

ALTER TABLE "CompetitorChange"        VALIDATE CONSTRAINT "CompetitorChange_tenantId_competitorId_fkey";
ALTER TABLE "CompetitorChange"        VALIDATE CONSTRAINT "CompetitorChange_tenantId_sourceId_fkey";

ALTER TABLE "CompetitorBrief"         VALIDATE CONSTRAINT "CompetitorBrief_tenantId_competitorId_fkey";

ALTER TABLE "CustomFieldValue"        VALIDATE CONSTRAINT "CustomFieldValue_tenantId_defId_fkey";

ALTER TABLE "SurveyResponse"          VALIDATE CONSTRAINT "SurveyResponse_tenantId_surveyId_fkey";

-- ── From 20260727150000 ──────────────────────────────────────────────────────

ALTER TABLE "Lead"                    VALIDATE CONSTRAINT "Lead_tenantId_stageId_fkey";
ALTER TABLE "Lead"                    VALIDATE CONSTRAINT "Lead_tenantId_productId_fkey";
ALTER TABLE "Lead"                    VALIDATE CONSTRAINT "Lead_tenantId_contactId_fkey";

ALTER TABLE "Quote"                   VALIDATE CONSTRAINT "Quote_tenantId_revisionOfId_fkey";
ALTER TABLE "Quote"                   VALIDATE CONSTRAINT "Quote_tenantId_leadId_fkey";
ALTER TABLE "Quote"                   VALIDATE CONSTRAINT "Quote_tenantId_contactId_fkey";

ALTER TABLE "StockUnit"               VALIDATE CONSTRAINT "StockUnit_tenantId_reservedForLeadId_fkey";
ALTER TABLE "StockUnit"               VALIDATE CONSTRAINT "StockUnit_tenantId_soldQuoteId_fkey";
ALTER TABLE "StockUnit"               VALIDATE CONSTRAINT "StockUnit_tenantId_purchaseOrderLineId_fkey";

ALTER TABLE "DocBuilderTemplate"      VALIDATE CONSTRAINT "DocBuilderTemplate_tenantId_defaultWorkflowId_fkey";

ALTER TABLE "CustomerCase"            VALIDATE CONSTRAINT "CustomerCase_tenantId_mailboxId_fkey";

-- ── From 20260727160000 ──────────────────────────────────────────────────────

ALTER TABLE "SurveyResponse"          VALIDATE CONSTRAINT "SurveyResponse_tenantId_contactId_fkey";
ALTER TABLE "SurveyResponse"          VALIDATE CONSTRAINT "SurveyResponse_tenantId_leadId_fkey";
ALTER TABLE "SurveyResponse"          VALIDATE CONSTRAINT "SurveyResponse_tenantId_jobCardId_fkey";

ALTER TABLE "SignatureRequest"        VALIDATE CONSTRAINT "SignatureRequest_tenantId_documentId_fkey";
ALTER TABLE "SignatureRequest"        VALIDATE CONSTRAINT "SignatureRequest_tenantId_quoteId_fkey";
ALTER TABLE "SignatureRequest"        VALIDATE CONSTRAINT "SignatureRequest_tenantId_jobCardId_fkey";
ALTER TABLE "SignatureRequest"        VALIDATE CONSTRAINT "SignatureRequest_tenantId_contactId_fkey";
ALTER TABLE "SignatureRequest"        VALIDATE CONSTRAINT "SignatureRequest_tenantId_templateId_fkey";

ALTER TABLE "DocInstance"             VALIDATE CONSTRAINT "DocInstance_tenantId_contactId_fkey";
ALTER TABLE "DocInstance"             VALIDATE CONSTRAINT "DocInstance_tenantId_leadId_fkey";
ALTER TABLE "DocInstance"             VALIDATE CONSTRAINT "DocInstance_tenantId_quoteId_fkey";

ALTER TABLE "Document"                VALIDATE CONSTRAINT "Document_tenantId_quoteId_fkey";
ALTER TABLE "Document"                VALIDATE CONSTRAINT "Document_tenantId_replacedById_fkey";

ALTER TABLE "CustomerCase"            VALIDATE CONSTRAINT "CustomerCase_tenantId_contactId_fkey";
ALTER TABLE "CustomerCase"            VALIDATE CONSTRAINT "CustomerCase_tenantId_vehicleId_fkey";

ALTER TABLE "CustomerCaseMessage"     VALIDATE CONSTRAINT "CustomerCaseMessage_tenantId_contactId_fkey";

ALTER TABLE "PortalNotification"      VALIDATE CONSTRAINT "PortalNotification_tenantId_contactId_fkey";

ALTER TABLE "PortalProfileChangeRequest" VALIDATE CONSTRAINT "PortalProfileChangeRequest_tenantId_contactId_fkey";

ALTER TABLE "PortalPreference"        VALIDATE CONSTRAINT "PortalPreference_tenantId_contactId_fkey";

ALTER TABLE "PortalUpload"            VALIDATE CONSTRAINT "PortalUpload_tenantId_contactId_fkey";
ALTER TABLE "PortalUpload"            VALIDATE CONSTRAINT "PortalUpload_tenantId_caseId_fkey";
ALTER TABLE "PortalUpload"            VALIDATE CONSTRAINT "PortalUpload_tenantId_vehicleId_fkey";

ALTER TABLE "PortalAccessGrant"       VALIDATE CONSTRAINT "PortalAccessGrant_tenantId_viewerContactId_fkey";
ALTER TABLE "PortalAccessGrant"       VALIDATE CONSTRAINT "PortalAccessGrant_tenantId_grantedContactId_fkey";
ALTER TABLE "PortalAccessGrant"       VALIDATE CONSTRAINT "PortalAccessGrant_tenantId_fleetId_fkey";

ALTER TABLE "WarrantyClaim"           VALIDATE CONSTRAINT "WarrantyClaim_tenantId_contactId_fkey";
ALTER TABLE "WarrantyClaim"           VALIDATE CONSTRAINT "WarrantyClaim_tenantId_jobCardId_fkey";

ALTER TABLE "BatteryCheck"            VALIDATE CONSTRAINT "BatteryCheck_tenantId_jobCardId_fkey";

ALTER TABLE "StockEvent"              VALIDATE CONSTRAINT "StockEvent_tenantId_leadId_fkey";
ALTER TABLE "StockEvent"              VALIDATE CONSTRAINT "StockEvent_tenantId_quoteId_fkey";

ALTER TABLE "Fleet"                   VALIDATE CONSTRAINT "Fleet_tenantId_contactId_fkey";

ALTER TABLE "ServiceReminderLog"      VALIDATE CONSTRAINT "ServiceReminderLog_tenantId_vehicleId_fkey";

ALTER TABLE "AuditLog"                VALIDATE CONSTRAINT "AuditLog_tenantId_contactId_fkey";
ALTER TABLE "AuditLog"                VALIDATE CONSTRAINT "AuditLog_tenantId_leadId_fkey";

ALTER TABLE "AutomationLog"           VALIDATE CONSTRAINT "AutomationLog_tenantId_leadId_fkey";
ALTER TABLE "AutomationLog"           VALIDATE CONSTRAINT "AutomationLog_tenantId_ruleId_fkey";

ALTER TABLE "AutomationRule"          VALIDATE CONSTRAINT "AutomationRule_tenantId_triggerStageId_fkey";
ALTER TABLE "AutomationRule"          VALIDATE CONSTRAINT "AutomationRule_tenantId_targetStageId_fkey";
ALTER TABLE "AutomationRule"          VALIDATE CONSTRAINT "AutomationRule_tenantId_emailTemplateId_fkey";

ALTER TABLE "Campaign"                VALIDATE CONSTRAINT "Campaign_tenantId_productId_fkey";
ALTER TABLE "Campaign"                VALIDATE CONSTRAINT "Campaign_tenantId_segmentId_fkey";
