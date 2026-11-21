-- THE 60-DAY TRASH PURGE HAS BEEN FAILING, SILENTLY (2026-11-21).
--
-- 20260727160000_composite_tenant_fks_loose_pointers gave the loose id columns below a (tenantId, id) foreign key
-- with no delete rule. Before it, nothing stopped the parent's delete; since it, one history row is enough to block it —
-- on production 5 audit rows held 2 contacts and 59 held 11 leads past their 60 days, and the purge swallowed the error.
--
-- These rows are HISTORY: who did what, a survey answer, a stock movement, a fleet's contact, a claim's claimant. They
-- stay; only their link to the purged record is cleared (ON DELETE SET NULL on that column alone, so tenantId is kept).
-- PAPERWORK (signature requests, generated documents, a quote's filed documents) keeps its no-delete rule on purpose:
-- the purge leaves a record with paperwork in the trash instead (src/lib/trash.ts), so the chain of documents holds.
--
-- Each constraint is re-added NOT VALID then validated, so the write lock is brief. Same name, columns and target.

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_tenantId_contactId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_contactId_fkey"
  FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE SET NULL ("contactId") NOT VALID;
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_tenantId_contactId_fkey";

ALTER TABLE "AuditLog" DROP CONSTRAINT IF EXISTS "AuditLog_tenantId_leadId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_leadId_fkey"
  FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE SET NULL ("leadId") NOT VALID;
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_tenantId_leadId_fkey";

ALTER TABLE "SurveyResponse" DROP CONSTRAINT IF EXISTS "SurveyResponse_tenantId_contactId_fkey";
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_contactId_fkey"
  FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE SET NULL ("contactId") NOT VALID;
ALTER TABLE "SurveyResponse" VALIDATE CONSTRAINT "SurveyResponse_tenantId_contactId_fkey";

ALTER TABLE "SurveyResponse" DROP CONSTRAINT IF EXISTS "SurveyResponse_tenantId_leadId_fkey";
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_leadId_fkey"
  FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE SET NULL ("leadId") NOT VALID;
ALTER TABLE "SurveyResponse" VALIDATE CONSTRAINT "SurveyResponse_tenantId_leadId_fkey";

ALTER TABLE "SurveyResponse" DROP CONSTRAINT IF EXISTS "SurveyResponse_tenantId_jobCardId_fkey";
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_tenantId_jobCardId_fkey"
  FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") ON DELETE SET NULL ("jobCardId") NOT VALID;
ALTER TABLE "SurveyResponse" VALIDATE CONSTRAINT "SurveyResponse_tenantId_jobCardId_fkey";

ALTER TABLE "StockEvent" DROP CONSTRAINT IF EXISTS "StockEvent_tenantId_leadId_fkey";
ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_leadId_fkey"
  FOREIGN KEY ("tenantId", "leadId") REFERENCES "Lead"("tenantId", "id") ON DELETE SET NULL ("leadId") NOT VALID;
ALTER TABLE "StockEvent" VALIDATE CONSTRAINT "StockEvent_tenantId_leadId_fkey";

ALTER TABLE "StockEvent" DROP CONSTRAINT IF EXISTS "StockEvent_tenantId_quoteId_fkey";
ALTER TABLE "StockEvent" ADD CONSTRAINT "StockEvent_tenantId_quoteId_fkey"
  FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE SET NULL ("quoteId") NOT VALID;
ALTER TABLE "StockEvent" VALIDATE CONSTRAINT "StockEvent_tenantId_quoteId_fkey";

ALTER TABLE "Fleet" DROP CONSTRAINT IF EXISTS "Fleet_tenantId_contactId_fkey";
ALTER TABLE "Fleet" ADD CONSTRAINT "Fleet_tenantId_contactId_fkey"
  FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE SET NULL ("contactId") NOT VALID;
ALTER TABLE "Fleet" VALIDATE CONSTRAINT "Fleet_tenantId_contactId_fkey";

ALTER TABLE "WarrantyClaim" DROP CONSTRAINT IF EXISTS "WarrantyClaim_tenantId_contactId_fkey";
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_tenantId_contactId_fkey"
  FOREIGN KEY ("tenantId", "contactId") REFERENCES "Contact"("tenantId", "id") ON DELETE SET NULL ("contactId") NOT VALID;
ALTER TABLE "WarrantyClaim" VALIDATE CONSTRAINT "WarrantyClaim_tenantId_contactId_fkey";

ALTER TABLE "WarrantyClaim" DROP CONSTRAINT IF EXISTS "WarrantyClaim_tenantId_jobCardId_fkey";
ALTER TABLE "WarrantyClaim" ADD CONSTRAINT "WarrantyClaim_tenantId_jobCardId_fkey"
  FOREIGN KEY ("tenantId", "jobCardId") REFERENCES "JobCard"("tenantId", "id") ON DELETE SET NULL ("jobCardId") NOT VALID;
ALTER TABLE "WarrantyClaim" VALIDATE CONSTRAINT "WarrantyClaim_tenantId_jobCardId_fkey";

ALTER TABLE "Campaign" DROP CONSTRAINT IF EXISTS "Campaign_tenantId_productId_fkey";
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_tenantId_productId_fkey"
  FOREIGN KEY ("tenantId", "productId") REFERENCES "Product"("tenantId", "id") ON DELETE SET NULL ("productId") NOT VALID;
ALTER TABLE "Campaign" VALIDATE CONSTRAINT "Campaign_tenantId_productId_fkey";
