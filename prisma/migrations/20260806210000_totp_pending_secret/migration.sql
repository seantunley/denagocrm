-- =============================================================================
-- ENROLLING A NEW AUTHENTICATOR MUST NOT DISARM THE CURRENT ONE
-- =============================================================================
--
-- `beginTotpEnrolment` overwrote `totpSecret` and set `totpEnabledAt = NULL` the
-- moment it was called. That is a working disable, reachable by anyone holding a
-- session — and a Server Action is a plain POST endpoint, so it is reachable
-- directly rather than only from the settings screen that renders the button.
--
-- The consequence is specific and bad: `disableTotp` deliberately demands a
-- current authenticator code, precisely so that somebody with a stolen session
-- cannot strip the second factor and keep their access after the victim rotates
-- their password. Beginning an "enrolment" achieved exactly that with no code at
-- all. The guard was real; the way around it was one function over.
--
-- The fix is somewhere to put a REPLACEMENT secret that is not yet the live one.
-- Enrolment writes here, the live secret is left untouched, and promotion only
-- happens once a code proves the new authenticator actually holds it.
--
-- Additive and nullable: every existing row keeps NULL, which reads as "no
-- enrolment in progress". Nothing is backfilled and no existing 2FA changes.
-- =============================================================================

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "totpPendingSecret" TEXT;

COMMENT ON COLUMN "User"."totpPendingSecret" IS
  'Encrypted secret for an authenticator being enrolled. Promoted to totpSecret only once a code proves possession; never used to authenticate.';
