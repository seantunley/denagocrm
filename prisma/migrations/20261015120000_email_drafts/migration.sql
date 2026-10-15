-- Email drafts and scheduled sends from the composer: an email kept as it is
-- written, or one the scheduled-emails cron sends at its time as the person who
-- scheduled it. Additive only; re-runnable.

CREATE TABLE IF NOT EXISTS "EmailDraft" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "contactId" TEXT,
  "leadId" TEXT,
  "to" TEXT NOT NULL DEFAULT '',
  "cc" TEXT NOT NULL DEFAULT '',
  "bcc" TEXT NOT NULL DEFAULT '',
  "replyTo" TEXT NOT NULL DEFAULT '',
  "subject" TEXT NOT NULL DEFAULT '',
  "bodyHtml" TEXT NOT NULL DEFAULT '',
  "attachIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "quoteIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "files" JSONB,
  "banner" TEXT NOT NULL DEFAULT '',
  "secureLinks" BOOLEAN NOT NULL DEFAULT false,
  "secureDays" INTEGER,
  "inReplyToId" TEXT,
  "sensitiveOk" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "sendAt" TIMESTAMP(3),
  "error" TEXT,
  "communicationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailDraft_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailDraft_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "EmailDraft_tenantId_userId_status_idx" ON "EmailDraft"("tenantId", "userId", "status");
CREATE INDEX IF NOT EXISTS "EmailDraft_tenantId_contactId_status_idx" ON "EmailDraft"("tenantId", "contactId", "status");
CREATE INDEX IF NOT EXISTS "EmailDraft_tenantId_leadId_status_idx" ON "EmailDraft"("tenantId", "leadId", "status");
CREATE INDEX IF NOT EXISTS "EmailDraft_status_sendAt_idx" ON "EmailDraft"("status", "sendAt");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. One workspace never reads or writes another's.
ALTER TABLE "EmailDraft" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "EmailDraft_tenant_isolation" ON "EmailDraft";
CREATE POLICY "EmailDraft_tenant_isolation" ON "EmailDraft"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "EmailDraft" FORCE ROW LEVEL SECURITY;
