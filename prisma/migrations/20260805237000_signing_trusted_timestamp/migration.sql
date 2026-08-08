-- =============================================================================
-- INDEPENDENT PROOF OF WHEN
-- =============================================================================
--
-- The evidence chain proves nobody altered a record without full database
-- access. It cannot prove to a third party WHEN anything happened, because the
-- whole chain is produced by this system and stored in its database — someone
-- holding both could rebuild it consistently. In a dispute that is the
-- difference between "our records say" and something the other side cannot
-- simply disbelieve.
--
-- An RFC 3161 timestamp authority closes it. We send a SHA-256 hash — never the
-- document, never a name, never a tenant — and an independent party returns a
-- signed token asserting that this hash existed at that moment. Public
-- authorities provide this at no cost, which is why it is built rather than
-- bought.
--
-- All three columns are nullable BY DESIGN. A timestamp is evidence about a
-- signature, not part of one: if the authority is unreachable the signature is
-- still valid and the document must still complete. NULL means "not
-- timestamped", recorded honestly, and a later pass can fill it in.
-- =============================================================================

ALTER TABLE "SignatureRequest"
  ADD COLUMN IF NOT EXISTS "timestampToken" TEXT,
  ADD COLUMN IF NOT EXISTS "timestampedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "timestampAuthority" TEXT;

COMMENT ON COLUMN "SignatureRequest"."timestampToken" IS
  'Base64 RFC 3161 token attesting that signedPdfHash existed at timestampedAt. NULL = not timestamped.';
