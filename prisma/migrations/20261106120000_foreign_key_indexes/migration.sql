-- Foreign-key indexes (2026-11-06 optimisation sweep). Additive only; re-runnable.
--
-- Postgres does not index a foreign key on its own. These 58 relations had no index
-- whose leading column is the key, so a join on them, and a delete or update of the
-- parent row (the FK check / cascade), scans the whole child table. Four already had a
-- (tenantId, key) index, which serves tenant-scoped queries but not the parent-side
-- check, which has no tenantId.
--
-- Generated with `prisma migrate diff` from the schema change in this commit, then made
-- IF NOT EXISTS. Not CONCURRENTLY: Prisma runs a migration in a transaction, and every
-- table here is small (largest ~1.6k rows on 2026-11-06), so the brief lock is harmless.

CREATE INDEX IF NOT EXISTS "ChecklistRun_templateId_idx" ON "ChecklistRun"("templateId");
CREATE INDEX IF NOT EXISTS "ChecklistEntry_itemId_idx" ON "ChecklistEntry"("itemId");
CREATE INDEX IF NOT EXISTS "RolePermission_permissionKey_idx" ON "RolePermission"("permissionKey");
CREATE INDEX IF NOT EXISTS "JourneyRun_journeyVersionId_idx" ON "JourneyRun"("journeyVersionId");
CREATE INDEX IF NOT EXISTS "TimelinePin_pinnedById_idx" ON "TimelinePin"("pinnedById");
CREATE INDEX IF NOT EXISTS "LibraryVersion_uploadedById_idx" ON "LibraryVersion"("uploadedById");
CREATE INDEX IF NOT EXISTS "StockUnit_purchaseOrderId_idx" ON "StockUnit"("purchaseOrderId");
CREATE INDEX IF NOT EXISTS "StockUnit_reservedForLeadId_idx" ON "StockUnit"("reservedForLeadId");
CREATE INDEX IF NOT EXISTS "StockReservation_quoteId_idx" ON "StockReservation"("quoteId");
CREATE INDEX IF NOT EXISTS "StockReservation_reservedById_idx" ON "StockReservation"("reservedById");
CREATE INDEX IF NOT EXISTS "PurchaseOrderLine_productId_idx" ON "PurchaseOrderLine"("productId");
CREATE INDEX IF NOT EXISTS "GoodsReceipt_receivedById_idx" ON "GoodsReceipt"("receivedById");
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_purchaseOrderLineId_idx" ON "GoodsReceiptLine"("purchaseOrderLineId");
CREATE INDEX IF NOT EXISTS "GoodsReceiptLine_stockUnitId_idx" ON "GoodsReceiptLine"("stockUnitId");
CREATE INDEX IF NOT EXISTS "ProductColor_productId_idx" ON "ProductColor"("productId");
CREATE INDEX IF NOT EXISTS "Contact_ownerId_idx" ON "Contact"("ownerId");
CREATE INDEX IF NOT EXISTS "Contact_createdById_idx" ON "Contact"("createdById");
CREATE INDEX IF NOT EXISTS "Campaign_createdById_idx" ON "Campaign"("createdById");
CREATE INDEX IF NOT EXISTS "CampaignRecipient_contactId_idx" ON "CampaignRecipient"("contactId");
CREATE INDEX IF NOT EXISTS "Lead_stageId_idx" ON "Lead"("stageId");
CREATE INDEX IF NOT EXISTS "Lead_productId_idx" ON "Lead"("productId");
CREATE INDEX IF NOT EXISTS "Lead_contactId_idx" ON "Lead"("contactId");
CREATE INDEX IF NOT EXISTS "Lead_assignedToId_idx" ON "Lead"("assignedToId");
CREATE INDEX IF NOT EXISTS "Lead_createdById_idx" ON "Lead"("createdById");
CREATE INDEX IF NOT EXISTS "Activity_leadId_idx" ON "Activity"("leadId");
CREATE INDEX IF NOT EXISTS "Activity_contactId_idx" ON "Activity"("contactId");
CREATE INDEX IF NOT EXISTS "Activity_createdById_idx" ON "Activity"("createdById");
CREATE INDEX IF NOT EXISTS "Quote_revisionOfId_idx" ON "Quote"("revisionOfId");
CREATE INDEX IF NOT EXISTS "Quote_leadId_idx" ON "Quote"("leadId");
CREATE INDEX IF NOT EXISTS "Quote_contactId_idx" ON "Quote"("contactId");
CREATE INDEX IF NOT EXISTS "Quote_createdById_idx" ON "Quote"("createdById");
CREATE INDEX IF NOT EXISTS "QuoteItem_quoteId_idx" ON "QuoteItem"("quoteId");
CREATE INDEX IF NOT EXISTS "Communication_userId_idx" ON "Communication"("userId");
CREATE INDEX IF NOT EXISTS "ConversationNote_authorId_idx" ON "ConversationNote"("authorId");
CREATE INDEX IF NOT EXISTS "ConversationDraft_ownerId_idx" ON "ConversationDraft"("ownerId");
CREATE INDEX IF NOT EXISTS "Document_contactId_idx" ON "Document"("contactId");
CREATE INDEX IF NOT EXISTS "Document_vehicleId_idx" ON "Document"("vehicleId");
CREATE INDEX IF NOT EXISTS "Document_jobCardId_idx" ON "Document"("jobCardId");
CREATE INDEX IF NOT EXISTS "Document_uploadedById_idx" ON "Document"("uploadedById");
CREATE INDEX IF NOT EXISTS "Vehicle_contactId_idx" ON "Vehicle"("contactId");
CREATE INDEX IF NOT EXISTS "Vehicle_productId_idx" ON "Vehicle"("productId");
CREATE INDEX IF NOT EXISTS "MileageLog_vehicleId_idx" ON "MileageLog"("vehicleId");
CREATE INDEX IF NOT EXISTS "ServiceRecord_vehicleId_idx" ON "ServiceRecord"("vehicleId");
CREATE INDEX IF NOT EXISTS "ServiceRecord_performedById_idx" ON "ServiceRecord"("performedById");
CREATE INDEX IF NOT EXISTS "JobCard_vehicleId_idx" ON "JobCard"("vehicleId");
CREATE INDEX IF NOT EXISTS "JobCard_contactId_idx" ON "JobCard"("contactId");
CREATE INDEX IF NOT EXISTS "JobCard_technicianId_idx" ON "JobCard"("technicianId");
CREATE INDEX IF NOT EXISTS "JobCardItem_jobCardId_idx" ON "JobCardItem"("jobCardId");
CREATE INDEX IF NOT EXISTS "JobCardItem_partId_idx" ON "JobCardItem"("partId");
CREATE INDEX IF NOT EXISTS "Referral_contactId_idx" ON "Referral"("contactId");
CREATE INDEX IF NOT EXISTS "DocBuilderTemplate_defaultWorkflowId_idx" ON "DocBuilderTemplate"("defaultWorkflowId");
CREATE INDEX IF NOT EXISTS "SignatureField_recipientId_idx" ON "SignatureField"("recipientId");
CREATE INDEX IF NOT EXISTS "SignatureView_requestId_idx" ON "SignatureView"("requestId");
CREATE INDEX IF NOT EXISTS "SignatureBannerLink_bannerId_idx" ON "SignatureBannerLink"("bannerId");
CREATE INDEX IF NOT EXISTS "SignatureBannerClick_bannerId_idx" ON "SignatureBannerClick"("bannerId");
CREATE INDEX IF NOT EXISTS "DocInstance_templateId_idx" ON "DocInstance"("templateId");
CREATE INDEX IF NOT EXISTS "CompetitorSnapshot_competitorId_idx" ON "CompetitorSnapshot"("competitorId");
CREATE INDEX IF NOT EXISTS "CompetitorChange_sourceId_idx" ON "CompetitorChange"("sourceId");
