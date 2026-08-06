-- =============================================================================
-- BACKUP CODES AND A SAFE ENROLMENT SLOT FOR PLATFORM ADMINISTRATORS
-- =============================================================================
--
-- PlatformAdmin already had `totpSecret` and `totpEnabledAt`. Nothing anywhere
-- in src/app/platform/ ever wrote them: the columns existed, the CRM's identical
-- ones were fully wired, and the console's own two-factor authentication was
-- never built. So the account that can create, brand and suspend every tenant on
-- the platform was protected by a password and nothing else, while an ordinary
-- sales rep in a tenant could enrol an authenticator and a passkey.
--
-- ── totpBackupCodes ─────────────────────────────────────────────────────────
--
-- Not optional here, because of recovery. A tenant user who loses their
-- authenticator asks an owner to reset it. A platform admin has nobody above
-- them — without backup codes the only way back in is an UPDATE against the
-- production database by hand, which is both an outage and a worse security
-- event than the one 2FA was added to prevent.
--
-- ── totpPendingSecret ───────────────────────────────────────────────────────
--
-- Somewhere to stage a REPLACEMENT authenticator that is not yet trusted.
--
-- Without it, beginning an enrolment overwrites the live secret and clears
-- `totpEnabledAt` — a working 2FA disable available to anyone holding a session,
-- and a Server Action is a POST endpoint reachable without the console screen
-- that renders the button. Disabling deliberately demands a current code so that
-- a stolen session cannot strip the factor and survive a password rotation;
-- "enrolling" walked straight around that guard. On this account, which has no
-- administrator above it, that is the difference between a contained incident
-- and a permanent one.
--
-- Both additive and nullable: every existing row keeps NULL, and nothing is
-- backfilled — a backup code has to be SHOWN to its owner once, and no migration
-- can do that.
-- =============================================================================

ALTER TABLE "PlatformAdmin"
  ADD COLUMN IF NOT EXISTS "totpBackupCodes" TEXT;

ALTER TABLE "PlatformAdmin"
  ADD COLUMN IF NOT EXISTS "totpPendingSecret" TEXT;

COMMENT ON COLUMN "PlatformAdmin"."totpPendingSecret" IS
  'Encrypted secret for an authenticator being enrolled. Promoted to totpSecret only once a code proves possession; never used to authenticate.';
