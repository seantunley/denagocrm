-- =============================================================================
-- BACKUP CODES FOR PLATFORM ADMINISTRATORS
-- =============================================================================
--
-- PlatformAdmin already had `totpSecret` and `totpEnabledAt`. Nothing anywhere
-- in src/app/platform/ ever wrote them: the columns existed, the CRM's identical
-- ones were fully wired, and the console's own two-factor authentication was
-- never built. So the account that can create, brand and suspend every tenant on
-- the platform was protected by a password and nothing else, while an ordinary
-- sales rep in a tenant could enrol an authenticator and a passkey.
--
-- This adds the one column that was missing to close that, and the reason it is
-- not optional here is recovery. A tenant user who loses their authenticator
-- asks an owner to reset it. A platform admin has nobody above them — without
-- backup codes the only way back in is an UPDATE against the production database
-- by hand, which is both an outage and a worse security event than the one 2FA
-- was added to prevent.
--
-- Additive and nullable: every existing row keeps NULL, which reads as "no codes
-- issued" exactly as it does on User. Nothing is backfilled, because a backup
-- code has to be SHOWN to its owner once and no migration can do that.
-- =============================================================================

ALTER TABLE "PlatformAdmin"
  ADD COLUMN IF NOT EXISTS "totpBackupCodes" TEXT;
