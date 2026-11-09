-- A supplier asked for one of its papers on a deal through an upload link (2026-11-09). Additive; re-runnable.
CREATE TABLE IF NOT EXISTS "DocumentRequest" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "vendorId" TEXT NOT NULL,
  "documentType" TEXT NOT NULL,
  "sentTo" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedById" TEXT,
  "fulfilledAt" TIMESTAMP(3),
  "documentId" TEXT,
  CONSTRAINT "DocumentRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentRequest_token_key" ON "DocumentRequest"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "DocumentRequest_tenantId_id_key" ON "DocumentRequest"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "DocumentRequest_tenantId_quoteId_idx" ON "DocumentRequest"("tenantId", "quoteId");
CREATE INDEX IF NOT EXISTS "DocumentRequest_tenantId_vendorId_idx" ON "DocumentRequest"("tenantId", "vendorId");

-- Within one workspace only: the quote and the supplier. (documentId is a pointer to the file that answered —
-- written by the upload route in the same workspace — with no key, so purging that document can't block anything.)
DO $$ BEGIN
  ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_tenantId_vendorId_fkey"
    FOREIGN KEY ("tenantId", "vendorId") REFERENCES "Vendor"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_tenantId_quoteId_fkey"
    FOREIGN KEY ("tenantId", "quoteId") REFERENCES "Quote"("tenantId", "id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "DocumentRequest" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "DocumentRequest_tenant_isolation" ON "DocumentRequest";
CREATE POLICY "DocumentRequest_tenant_isolation" ON "DocumentRequest"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "DocumentRequest" FORCE ROW LEVEL SECURITY;
