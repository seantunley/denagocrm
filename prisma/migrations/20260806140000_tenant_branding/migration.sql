-- Per-tenant branding: four nullable columns on Tenant, and the hostname table
-- that lets a pre-auth page (the login screens) work out whose brand to render.
--
-- ADDITIVE AND IDEMPOTENT ONLY. Every statement is ADD COLUMN IF NOT EXISTS,
-- CREATE TABLE IF NOT EXISTS or CREATE INDEX IF NOT EXISTS. Nothing existing is
-- dropped, renamed, retyped or made NOT NULL.
--
-- EXPAND-SAFE, which is the property that matters on this deployment. vercel.json
-- runs `apply-migrations && next build`, so the schema changes while the PREVIOUS
-- build is still serving production traffic. Four nullable columns that build
-- never selects are invisible to it, and a table it never queries costs it
-- nothing. It keeps running unchanged until the new build takes over. No
-- backfill, no contract step, no downtime, no window in which the deployed code
-- and the schema disagree.
--
-- NOTHING CHANGES VISUALLY ON APPLY. All four columns land NULL, no TenantDomain
-- rows exist, and lib/tenantBrand.ts treats "no row" and "no brand" as the same
-- answer: the existing Denago defaults. The first visible change happens when a
-- platform admin fills the form in, which is a separate, reversible action.

-- Tenant ----------------------------------------------------------------------
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "brandPrimary"     TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "brandLogoRef"     TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "brandDisplayName" TEXT;
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "brandTagline"     TEXT;

-- TenantDomain ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "TenantDomain" (
  "id"         TEXT NOT NULL,
  "tenantId"   TEXT NOT NULL,
  "hostname"   TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TenantDomain_pkey" PRIMARY KEY ("id")
);

-- ONE ADDRESS, ONE TENANT — enforced by the database rather than by a check in
-- the console, because this is the signal the login pages trust before anyone has
-- authenticated. A second row for the same hostname would make "whose brand is
-- this?" depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS "TenantDomain_hostname_key" ON "TenantDomain"("hostname");
CREATE INDEX IF NOT EXISTS "TenantDomain_tenantId_idx" ON "TenantDomain"("tenantId");

-- FK with ON DELETE CASCADE: a deleted tenant must not leave a hostname pointing
-- at nothing, because a dangling row is a hostname that resolves to a tenant that
-- no longer exists. Unlike the Phase-B scalar-tenantId convention this is a real
-- relation to Tenant itself (not a tenant-scoping column), so the FK is correct
-- here for the same reason TenantMember has one.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'TenantDomain_tenantId_fkey'
  ) THEN
    ALTER TABLE "TenantDomain"
      ADD CONSTRAINT "TenantDomain_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- RLS. FORCE ROW LEVEL SECURITY has been live since 20260727130000_rls_enforce,
-- and a table added afterwards WITHOUT a policy is a table with no DB-layer
-- boundary at all. Same shape as every other tenant-owned table.
--
-- The pre-auth lookup in lib/tenantBrand.ts reads this through `basePrisma`,
-- which sets app.bypass_rls='on' for model ops AND for all four raw methods
-- (db.ts buildBypassClient) — so the lookup keeps working under the restricted,
-- non-BYPASSRLS role the RLS work is heading for. That is deliberate: a login
-- page cannot have a tenant scope, because working out the tenant is what it is
-- for.
ALTER TABLE "TenantDomain" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "TenantDomain_tenant_isolation" ON "TenantDomain";
CREATE POLICY "TenantDomain_tenant_isolation" ON "TenantDomain"
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  )
  WITH CHECK (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant', true)
  );
ALTER TABLE "TenantDomain" FORCE ROW LEVEL SECURITY;
