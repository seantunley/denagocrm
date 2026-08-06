-- =============================================================================
-- SIGNING CAPABILITIES ARE NEVER STORED IN PLAINTEXT
-- =============================================================================
--
-- A signing link is a bearer credential: whoever holds it can open, fill and
-- sign somebody's contract. Until now the raw value sat in
-- "SignatureRecipient".token in the clear, which means a database dump, a
-- nightly backup file, an over-broad support query, or any read reaching the
-- table by a path that does not evaluate row-level security hands over a working
-- ability to sign as the customer. Every other secret in this system is already
-- hashed or encrypted; these were the exception.
--
-- ── The shape ---------------------------------------------------------------
--
--   "token"           the SHA-256 DIGEST of the capability (64 lowercase hex).
--                     Lookup key. Keeps its existing UNIQUE index, so the
--                     application still resolves a link in one indexed read — it
--                     simply hashes the value out of the URL before querying.
--   "tokenCiphertext" AES-256-GCM of the raw value, encrypted by the application
--                     under SETTINGS_ENCRYPTION_KEY. PostgreSQL deliberately does
--                     not hold that key, so this migration cannot and does not
--                     populate it for historic rows.
--
-- The digest is what authenticates; the ciphertext exists only so a reminder can
-- re-send the SAME link rather than silently invalidating the one already in the
-- signer's inbox. A row with no ciphertext is not broken — it signs normally, and
-- a re-send rotates it to a fresh capability instead.
--
-- ── Why in place, and why this is safe for live links -----------------------
--
-- Historic links keep working. The raw token in an already-delivered URL hashes
-- to the digest stored here, and every lookup now hashes before it queries, so an
-- email sent last month still opens. Nothing is invalidated by this change.
--
-- The conversion is GUARDED on the value not already being a 64-hex digest.
-- Re-running must never double-hash: a double-hashed token matches nothing and
-- would silently kill every outstanding signing link in the system. This
-- repository has a documented history of a migration recorded as applied whose
-- SQL never ran, so replay safety here is not hypothetical.
--
-- Existing tokens are 56 hex characters (28 random bytes) and digests are 64, so
-- the guard is unambiguous in both directions.
-- =============================================================================

SET app.bypass_rls = 'on';

-- Recipient signing capabilities.
UPDATE "SignatureRecipient"
SET "token" = encode(digest("token", 'sha256'), 'hex')
WHERE "token" IS NOT NULL
  AND "token" !~ '^[0-9a-f]{64}$';

-- Approval capabilities, same contract.
UPDATE "ApprovalStep"
SET "token" = encode(digest("token", 'sha256'), 'hex')
WHERE "token" IS NOT NULL
  AND "token" !~ '^[0-9a-f]{64}$';

-- Fail the deploy rather than leave a readable capability behind. If anything
-- above did not convert, the application would still authenticate by digest and
-- the plaintext row would sit there unnoticed — the exact state this migration
-- exists to end, so it must be loud.
DO $$
DECLARE leftover INTEGER;
BEGIN
  SELECT count(*) INTO leftover FROM (
    SELECT "token" FROM "SignatureRecipient" WHERE "token" IS NOT NULL AND "token" !~ '^[0-9a-f]{64}$'
    UNION ALL
    SELECT "token" FROM "ApprovalStep" WHERE "token" IS NOT NULL AND "token" !~ '^[0-9a-f]{64}$'
  ) unconverted;
  IF leftover > 0 THEN
    RAISE EXCEPTION 'Signing token vault aborted: % capability value(s) are still not digests', leftover;
  END IF;
END $$;

-- Defence in depth against a future code path that writes a raw capability. The
-- application hashes before it writes; this refuses the write if it ever forgets,
-- rather than storing a readable token and carrying on.
CREATE OR REPLACE FUNCTION signing_reject_plaintext_capability() RETURNS trigger AS $$
BEGIN
  IF NEW."token" IS NOT NULL AND NEW."token" !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION '% capability must be stored as a SHA-256 digest, not a raw token', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureRecipient_hash_token" ON "SignatureRecipient";
DROP TRIGGER IF EXISTS "SignatureRecipient_reject_plaintext_token" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_reject_plaintext_token"
BEFORE INSERT OR UPDATE OF "token" ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_reject_plaintext_capability();

DROP TRIGGER IF EXISTS "ApprovalStep_hash_token" ON "ApprovalStep";
DROP TRIGGER IF EXISTS "ApprovalStep_reject_plaintext_token" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_reject_plaintext_token"
BEFORE INSERT OR UPDATE OF "token" ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_reject_plaintext_capability();

COMMENT ON COLUMN "SignatureRecipient"."token" IS
  'SHA-256 digest of the signing capability. The raw value exists only in the delivered URL.';
COMMENT ON COLUMN "SignatureRecipient"."tokenCiphertext" IS
  'AES-256-GCM of the raw capability, for re-sending the same link. NULL means a re-send rotates instead.';
COMMENT ON COLUMN "ApprovalStep"."token" IS
  'SHA-256 digest of the approval capability. The raw value exists only in the delivered URL.';
COMMENT ON COLUMN "ApprovalStep"."tokenCiphertext" IS
  'AES-256-GCM of the raw capability, for re-sending the same link. NULL means a re-send rotates instead.';

RESET app.bypass_rls;
