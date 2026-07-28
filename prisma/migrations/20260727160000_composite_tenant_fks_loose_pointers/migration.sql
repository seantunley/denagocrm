-- Composite tenant FK constraints for all remaining loose-pointer scalar *Id fields
-- that were not covered by migrations 20260727140000 or 20260727150000.
--
-- "Loose pointer" = a scalar *Id field in a tenant-scoped model that references
-- another tenant-scoped model but has NO explicit Prisma @relation directive.
-- Without composite FKs, Postgres cannot prevent a child row from referencing a
-- parent in a different tenant via these fields.
--
-- Same pattern as prior FK migrations:
--   - NOT VALID: existing rows not checked; only new/updated rows enforced.
--   - DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--     for idempotency (Postgres has no ADD CONSTRAINT IF NOT EXISTS).
--
-- =============================================================================
-- STEP 1: New parent composite unique indexes
-- (required before Postgres will accept a composite FK referencing them)
-- =============================================================================

-- Document: referenced by SignatureRequest.documentId and Document.replacedById
CREATE UNIQUE INDEX IF NOT EXISTS "Document_tenantId_id_key"      ON "Document"("tenantId", "id");
-- AutomationRule: referenced by AutomationLog.ruleId
CREATE UNIQUE INDEX IF NOT EXISTS "AutomationRule_tenantId_id_key" ON "AutomationRule"("tenantId", "id");
-- EmailTemplate: referenced by AutomationRule.emailTemplateId
CREATE UNIQUE INDEX IF NOT EXISTS "EmailTemplate_tenantId_id_key"  ON "EmailTemplate"("tenantId", "id");
-- Segment: referenced by Campaign.segmentId
CREATE UNIQUE INDEX IF NOT EXISTS "Segment_tenantId_id_key"        ON "Segment"("tenantId", "id");

-- =============================================================================
-- STEP 2: Composite FK constraints (NOT VALID, idempotent via DO blocks)
-- =============================================================================

-- ── SurveyResponse loose pointers ────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── SignatureRequest loose pointers ──────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_tenantId_documentId_fkey"
    FOREIGN KEY ("tenantId", "documentId") REFERENCES "Document"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_tenantId_templateId_fkey"
    FOREIGN KEY ("tenantId", "templateId") REFERENCES "DocBuilderTemplate"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── DocInstance loose pointers ────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "DocInstance" ADD CONSTRAINT "DocInstance_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocInstance" ADD CONSTRAINT "DocInstance_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "DocInstance" ADD CONSTRAINT "DocInstance_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Document loose pointers (explicit @relation covers contact/vehicle/jobCard already) ──
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Document → Document (self-ref: replacedById points to the superseded file)
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_tenantId_replacedById_fkey"
    FOREIGN KEY ("tenantId", "replacedById") REFERENCES "Document"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── CustomerCase loose pointers ───────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "CustomerCase" ADD CONSTRAINT "CustomerCase_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── CustomerCaseMessage loose pointers ────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "CustomerCaseMessage" ADD CONSTRAINT "CustomerCaseMessage_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PortalNotification loose pointers ─────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "PortalNotification" ADD CONSTRAINT "PortalNotification_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PortalProfileChangeRequest loose pointers ─────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "PortalProfileChangeRequest" ADD CONSTRAINT "PortalProfileChangeRequest_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PortalPreference (contactId is the PK and the FK to Contact) ──────────────
DO $$ BEGIN
  ALTER TABLE "PortalPreference" ADD CONSTRAINT "PortalPreference_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PortalUpload loose pointers ───────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_tenantId_caseId_fkey"
    FOREIGN KEY ("tenantId", "caseId") REFERENCES "CustomerCase"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PortalUpload" ADD CONSTRAINT "PortalUpload_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── PortalAccessGrant loose pointers ─────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_tenantId_viewerContactId_fkey"
    FOREIGN KEY ("tenantId", "viewerContactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_tenantId_grantedContactId_fkey"
    FOREIGN KEY ("tenantId", "grantedContactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "PortalAccessGrant" ADD CONSTRAINT "PortalAccessGrant_tenantId_fleetId_fkey"
    FOREIGN KEY ("tenantId", "fleetId") REFERENCES "Fleet"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── WarrantyClaim loose pointers ──────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── BatteryCheck loose pointer ────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "BatteryCheck" ADD CONSTRAINT "BatteryCheck_tenantId_jobCardId_fkey"
    FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── StockEvent loose pointers (stockUnitId + purchaseOrderId already covered) ─
DO $$ BEGIN
  ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Fleet loose pointer (contactId = primary contact / fleet manager) ─────────
DO $$ BEGIN
  ALTER TABLE "Fleet" ADD CONSTRAINT "Fleet_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── ServiceReminderLog loose pointer ──────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "ServiceReminderLog" ADD CONSTRAINT "ServiceReminderLog_tenantId_vehicleId_fkey"
    FOREIGN KEY ("tenantId", "vehicleId") REFERENCES "Vehicle"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── AuditLog loose pointers ───────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_contactId_fkey"
    FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── AutomationLog loose pointers ──────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "AutomationLog" ADD CONSTRAINT "AutomationLog_tenantId_leadId_fkey"
    FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutomationLog" ADD CONSTRAINT "AutomationLog_tenantId_ruleId_fkey"
    FOREIGN KEY ("tenantId", "ruleId") REFERENCES "AutomationRule"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── AutomationRule loose pointers ─────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_triggerStageId_fkey"
    FOREIGN KEY ("tenantId", "triggerStageId") REFERENCES "PipelineStage"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_targetStageId_fkey"
    FOREIGN KEY ("tenantId", "targetStageId") REFERENCES "PipelineStage"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_emailTemplateId_fkey"
    FOREIGN KEY ("tenantId", "emailTemplateId") REFERENCES "EmailTemplate"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Campaign loose pointers ───────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_productId_fkey"
    FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_segmentId_fkey"
    FOREIGN KEY ("tenantId", "segmentId") REFERENCES "Segment"("tenantId", "id") NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
