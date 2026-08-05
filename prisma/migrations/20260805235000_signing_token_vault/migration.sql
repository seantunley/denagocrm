-- Signing and approval bearer secrets are encrypted by the application and looked
-- up by SHA-256 digest. The database trigger may backfill a legacy plaintext row,
-- but it must never replace the digest when ciphertext or a revocation marker is
-- written later.
SET app.bypass_rls = 'on';

CREATE OR REPLACE FUNCTION signing_hash_bearer_token() RETURNS trigger AS $$
BEGIN
  IF NEW."tokenHash" IS NULL AND NEW."token" IS NOT NULL THEN
    NEW."tokenHash" := encode(digest(NEW."token", 'sha256'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureRecipient_hash_token" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_hash_token"
BEFORE INSERT OR UPDATE OF "token","tokenHash" ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_hash_bearer_token();

DROP TRIGGER IF EXISTS "ApprovalStep_hash_token" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_hash_token"
BEFORE INSERT OR UPDATE OF "token","tokenHash" ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_hash_bearer_token();

-- Existing rows remain usable through their already-backfilled tokenHash. They
-- are encrypted lazily on first trusted access because PostgreSQL deliberately
-- does not possess SETTINGS_ENCRYPTION_KEY.
COMMENT ON COLUMN "SignatureRecipient"."token" IS
  'AES-256-GCM ciphertext (enc:v1:...) for new rows; legacy plaintext upgrades lazily. Lookup by tokenHash only.';
COMMENT ON COLUMN "ApprovalStep"."token" IS
  'AES-256-GCM ciphertext (enc:v1:...) for new rows; legacy plaintext upgrades lazily. Lookup by tokenHash only.';

RESET app.bypass_rls;
