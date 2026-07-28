-- Supplemental composite tenant FK constraints missed in 20260727140000.
-- Same NOT VALID / DO-block pattern as the primary migration.
--
-- New parent unique indexes (PipelineStage and SignWorkflow were not in the
-- original 29 parents; their @@unique([tenantId, id]) is now in schema.prisma).
CREATE UNIQUE INDEX IF NOT EXISTS "PipelineStage_tenantId_id_key" ON "PipelineStage"("tenantId", "id");
CREATE UNIQUE INDEX IF NOT EXISTS "SignWorkflow_tenantId_id_key" ON "SignWorkflow"("tenantId", "id");

-- Lead → PipelineStage (stageId)
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_stageId_fkey"
    FOREIGN KEY ("tenantId", "stageId") REFERENCES "PipelineStage"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lead → Product (productId)
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Lead → Contact (contactId)
DO $$ BEGIN
  ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Quote → Quote self-ref (revisionOfId)
DO $$ BEGIN
  ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_revisionOfId_fkey"
    FOREIGN KEY ("tenantId", "revisionOfId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Quote → Lead (leadId)
DO $$ BEGIN
  ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Quote → Contact (contactId)
DO $$ BEGIN
  ALTER TABLE "Quote" ADD CONSTRAINT "Quote_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockUnit → Lead (reservedForLeadId)
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_tenantId_reservedForLeadId_fkey"
    FOREIGN KEY ("tenantId", "reservedForLeadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockUnit → Quote (soldQuoteId)
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_tenantId_soldQuoteId_fkey"
    FOREIGN KEY ("tenantId", "soldQuoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- StockUnit → PurchaseOrderLine (purchaseOrderLineId)
DO $$ BEGIN
  ALTER TABLE "StockUnit" ADD CONSTRAINT "StockUnit_tenantId_purchaseOrderLineId_fkey"
    FOREIGN KEY ("tenantId", "purchaseOrderLineId") REFERENCES "PurchaseOrderLine"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DocBuilderTemplate → SignWorkflow (defaultWorkflowId)
DO $$ BEGIN
  ALTER TABLE "DocBuilderTemplate" ADD CONSTRAINT "DocBuilderTemplate_tenantId_defaultWorkflowId_fkey"
    FOREIGN KEY ("tenantId", "defaultWorkflowId") REFERENCES "SignWorkflow"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CustomerCase → SupportMailbox (mailboxId)
DO $$ BEGIN
  ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_tenantId_mailboxId_fkey"
    FOREIGN KEY ("tenantId", "mailboxId") REFERENCES "SupportMailbox"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
