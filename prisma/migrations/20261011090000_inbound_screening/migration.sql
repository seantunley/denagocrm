-- Incoming-message screening (spam quarantine) for WhatsApp, Messenger and
-- Instagram. Three new tables; nothing existing is changed. Additive and
-- re-runnable. Screening is OFF for every workspace until its owner turns it
-- on, so applying this changes no behaviour.

CREATE TABLE IF NOT EXISTS "InboundScreening" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "eventId" TEXT,
  "senderName" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'text',
  "body" TEXT NOT NULL DEFAULT '',
  "payload" JSONB NOT NULL,
  "classification" TEXT NOT NULL,
  "uncertain" BOOLEAN NOT NULL DEFAULT false,
  "decidedBy" TEXT NOT NULL,
  "reasonCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "reason" TEXT NOT NULL DEFAULT '',
  "policyVersion" TEXT NOT NULL,
  "model" TEXT,
  "aiUsed" BOOLEAN NOT NULL DEFAULT false,
  "aiInputTokens" INTEGER,
  "aiOutputTokens" INTEGER,
  "latencyMs" INTEGER NOT NULL DEFAULT 0,
  "failure" TEXT,
  "mode" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "suppressed" JSONB,
  "staffLabel" TEXT,
  "labelledById" TEXT,
  "labelledAt" TIMESTAMP(3),
  "restoredById" TEXT,
  "restoredAt" TIMESTAMP(3),
  "contactId" TEXT,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundScreening_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundScreening_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InboundScreening_tenantId_channel_providerId_key" ON "InboundScreening"("tenantId", "channel", "providerId");
CREATE INDEX IF NOT EXISTS "InboundScreening_tenantId_state_receivedAt_idx" ON "InboundScreening"("tenantId", "state", "receivedAt");
CREATE INDEX IF NOT EXISTS "InboundScreening_tenantId_channel_senderId_receivedAt_idx" ON "InboundScreening"("tenantId", "channel", "senderId", "receivedAt");
CREATE INDEX IF NOT EXISTS "InboundScreening_tenantId_staffLabel_idx" ON "InboundScreening"("tenantId", "staffLabel");
CREATE INDEX IF NOT EXISTS "InboundScreening_tenantId_contactId_idx" ON "InboundScreening"("tenantId", "contactId");

CREATE TABLE IF NOT EXISTS "InboundSenderRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "rule" TEXT NOT NULL,
  "senderName" TEXT,
  "note" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundSenderRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundSenderRule_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InboundSenderRule_tenantId_channel_senderId_key" ON "InboundSenderRule"("tenantId", "channel", "senderId");
CREATE INDEX IF NOT EXISTS "InboundSenderRule_tenantId_rule_idx" ON "InboundSenderRule"("tenantId", "rule");

CREATE TABLE IF NOT EXISTS "InboundSpamPattern" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'proposed',
  "sourceId" TEXT,
  "hits" INTEGER NOT NULL DEFAULT 0,
  "createdById" TEXT,
  "decidedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundSpamPattern_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InboundSpamPattern_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "InboundSpamPattern_tenantId_kind_value_key" ON "InboundSpamPattern"("tenantId", "kind", "value");
CREATE INDEX IF NOT EXISTS "InboundSpamPattern_tenantId_status_idx" ON "InboundSpamPattern"("tenantId", "status");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is
-- what makes the grant safe. Without it the table fails closed in production.
ALTER TABLE "InboundScreening" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "InboundScreening_tenant_isolation" ON "InboundScreening";
CREATE POLICY "InboundScreening_tenant_isolation" ON "InboundScreening"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "InboundScreening" FORCE ROW LEVEL SECURITY;

ALTER TABLE "InboundSenderRule" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "InboundSenderRule_tenant_isolation" ON "InboundSenderRule";
CREATE POLICY "InboundSenderRule_tenant_isolation" ON "InboundSenderRule"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "InboundSenderRule" FORCE ROW LEVEL SECURITY;

ALTER TABLE "InboundSpamPattern" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "InboundSpamPattern_tenant_isolation" ON "InboundSpamPattern";
CREATE POLICY "InboundSpamPattern_tenant_isolation" ON "InboundSpamPattern"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "InboundSpamPattern" FORCE ROW LEVEL SECURITY;

-- The permission that gates reviewing quarantine. Given to every role that can
-- already reply in the inbox, in every workspace: those people see every
-- customer message today, so this shows them nothing new.
SET app.bypass_rls = 'on';
INSERT INTO "Permission" ("key", "description", "category") VALUES
  ('inbox.spam', 'Review quarantined messages: restore, block or always allow a sender', 'Inbox')
ON CONFLICT ("key") DO UPDATE SET "description" = EXCLUDED."description", "category" = EXCLUDED."category";
INSERT INTO "RolePermission" ("roleId", "permissionKey", "tenantId")
SELECT held."roleId", 'inbox.spam', r."tenantId"
FROM "RolePermission" held JOIN "Role" r ON r."id" = held."roleId"
WHERE held."permissionKey" = 'inbox.reply'
ON CONFLICT DO NOTHING;
RESET app.bypass_rls;
