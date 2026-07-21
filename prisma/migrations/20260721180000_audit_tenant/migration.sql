-- Tenant-attribute the customer-history audit trail (multi-tenancy). Additive
-- and nullable: existing rows and system/cron/portal writes stay NULL.
ALTER TABLE "AuditLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
CREATE INDEX IF NOT EXISTS "AuditLog_tenantId_createdAt_idx"
  ON "AuditLog" ("tenantId", "createdAt");
