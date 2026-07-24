-- One-response-per-recipient for signature fields.
--
-- `SignatureField.value` holds only the FIRST committed value (the field has a
-- single placed position, so the sealed PDF can stamp exactly one value there).
-- On a SHARED field (recipientId null, fillable by any recipient) every later
-- signer's answer was previously lost — overwritten, then (after the first-write-
-- wins guard) silently dropped. This table records each recipient's response
-- individually so no acknowledgement is discarded.
--
-- Purely additive: a new table + its indexes/FKs. Touches no existing table or
-- column, so it is safe on the live database and idempotent (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS "SignatureFieldResponse" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "fieldId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "filledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SignatureFieldResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SignatureFieldResponse_fieldId_recipientId_key"
    ON "SignatureFieldResponse"("fieldId", "recipientId");
CREATE INDEX IF NOT EXISTS "SignatureFieldResponse_recipientId_idx"
    ON "SignatureFieldResponse"("recipientId");
CREATE INDEX IF NOT EXISTS "SignatureFieldResponse_tenantId_idx"
    ON "SignatureFieldResponse"("tenantId");

-- DROP-then-ADD makes the FK creation idempotent (Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS), so a re-run after a partial apply is safe.
ALTER TABLE "SignatureFieldResponse" DROP CONSTRAINT IF EXISTS "SignatureFieldResponse_fieldId_fkey";
ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_fieldId_fkey"
    FOREIGN KEY ("fieldId") REFERENCES "SignatureField"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SignatureFieldResponse" DROP CONSTRAINT IF EXISTS "SignatureFieldResponse_recipientId_fkey";
ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_recipientId_fkey"
    FOREIGN KEY ("recipientId") REFERENCES "SignatureRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
