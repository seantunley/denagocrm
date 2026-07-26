-- Additive: content fingerprint for atomic signing-request create-or-reuse.
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "contentFingerprint" TEXT;

-- Partial unique index: at most one OPEN (not soft-deleted, not closed) request
-- per content fingerprint. Prisma's schema DSL can't express a partial unique
-- constraint, so this index is the sole enforcement point for atomic
-- create-or-reuse in createOrReuseSignatureRequestFromDoc() — see
-- src/lib/signing/service.ts. A closed/deleted request never blocks a fresh
-- send of byte-identical content later.
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRequest_open_fingerprint_key"
  ON "SignatureRequest"("contentFingerprint")
  WHERE "contentFingerprint" IS NOT NULL
    AND "deletedAt" IS NULL
    AND "status" NOT IN ('completed', 'declined', 'voided', 'expired', 'rejected');
