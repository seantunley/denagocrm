-- Counted links in email signatures (the Email signatures pack, 2026-11-20: item 11 of
-- email-signature-improvements.md). Additive: a new table, used only once the owner switches link counting on.
CREATE TABLE IF NOT EXISTS "SignatureLink" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "clickCount" INTEGER NOT NULL DEFAULT 0,
  "lastClickAt" TIMESTAMP(3),
  "clickDay" TEXT,
  "dayClicks" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignatureLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SignatureLink_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureLink_token_key" ON "SignatureLink"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureLink_tenantId_userId_url_key" ON "SignatureLink"("tenantId", "userId", "url");
CREATE INDEX IF NOT EXISTS "SignatureLink_tenantId_userId_idx" ON "SignatureLink"("tenantId", "userId");

-- New tables reach crm_app through ALTER DEFAULT PRIVILEGES; the policy is what makes the grant safe. One workspace
-- never reads or writes another's (the same policy as the signature banner tables).
ALTER TABLE "SignatureLink" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SignatureLink_tenant_isolation" ON "SignatureLink";
CREATE POLICY "SignatureLink_tenant_isolation" ON "SignatureLink"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "SignatureLink" FORCE ROW LEVEL SECURITY;
