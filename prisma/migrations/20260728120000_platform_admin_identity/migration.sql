-- Platform-admin identity, deliberately OUTSIDE the tenant model.
--
-- These tables give the /platform console its own login, independent of any
-- tenant (the founding Denago Cape Town tenant included). A PlatformAdmin is not
-- a "User" and holds no "TenantMember" row, so console access no longer flows
-- through a CRM account's global role.
--
-- Intentionally NO tenantId column on either table: a cross-tenant administrator
-- that belonged to a tenant would be a contradiction. Both tables must stay OUT
-- of the tenant contract and the RLS scaffolding.
--
-- Replay-safe (IF NOT EXISTS throughout) so re-running against a partially
-- migrated database is harmless.

CREATE TABLE IF NOT EXISTS "PlatformAdmin" (
  "id"                TEXT         NOT NULL,
  "email"             TEXT         NOT NULL,
  "name"              TEXT         NOT NULL,
  "passwordHash"      TEXT         NOT NULL,
  "totpSecret"        TEXT,
  "totpEnabledAt"     TIMESTAMP(3),
  "disabledAt"        TIMESTAMP(3),
  "sessionVersion"    INTEGER      NOT NULL DEFAULT 0,
  "lastLoginAt"       TIMESTAMP(3),
  "passwordChangedAt" TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformAdmin_email_key"
  ON "PlatformAdmin"("email");

CREATE INDEX IF NOT EXISTS "PlatformAdmin_disabledAt_idx"
  ON "PlatformAdmin"("disabledAt");

CREATE TABLE IF NOT EXISTS "PlatformAdminSession" (
  "id"           TEXT         NOT NULL,
  "jti"          TEXT         NOT NULL,
  "ip"           TEXT,
  "userAgent"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"    TIMESTAMP(3),
  "adminId"      TEXT         NOT NULL,

  CONSTRAINT "PlatformAdminSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformAdminSession_jti_key"
  ON "PlatformAdminSession"("jti");

CREATE INDEX IF NOT EXISTS "PlatformAdminSession_adminId_idx"
  ON "PlatformAdminSession"("adminId");

CREATE INDEX IF NOT EXISTS "PlatformAdminSession_revokedAt_idx"
  ON "PlatformAdminSession"("revokedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'PlatformAdminSession_adminId_fkey'
  ) THEN
    ALTER TABLE "PlatformAdminSession"
      ADD CONSTRAINT "PlatformAdminSession_adminId_fkey"
      FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
