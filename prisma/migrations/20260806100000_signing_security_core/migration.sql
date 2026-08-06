-- Deployment-grade signing trust architecture.
--
-- This migration is intentionally fail-closed. It first resolves tenant ownership
-- for every existing signing row, then adds durable custody/orchestration/evidence
-- structures, then enables database-enforced isolation and immutability.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Existing signing graph: authoritative tenant ownership and frozen metadata.
-- ---------------------------------------------------------------------------

UPDATE "SignatureRequest" request
SET "tenantId" = COALESCE(
  request."tenantId",
  (SELECT quote."tenantId" FROM "Quote" quote WHERE quote.id=request."quoteId"),
  (SELECT job."tenantId" FROM "JobCard" job WHERE job.id=request."jobCardId"),
  (SELECT contact."tenantId" FROM "Contact" contact WHERE contact.id=request."contactId"),
  (SELECT document."tenantId" FROM "Document" document WHERE document.id=request."documentId"),
  (SELECT creator."tenantId" FROM "User" creator WHERE creator.id=request."createdById")
)
WHERE request."tenantId" IS NULL;

UPDATE "SignatureRecipient" child SET "tenantId"=parent."tenantId"
FROM "SignatureRequest" parent
WHERE child."requestId"=parent.id AND child."tenantId" IS NULL;

UPDATE "SignatureField" child SET "tenantId"=parent."tenantId"
FROM "SignatureRequest" parent
WHERE child."requestId"=parent.id AND child."tenantId" IS NULL;

UPDATE "SignatureFieldResponse" child SET "tenantId"=field."tenantId"
FROM "SignatureField" field
WHERE child."fieldId"=field.id AND child."tenantId" IS NULL;

UPDATE "SignatureEvent" child SET "tenantId"=parent."tenantId"
FROM "SignatureRequest" parent
WHERE child."requestId"=parent.id AND child."tenantId" IS NULL;

UPDATE "ApprovalStep" child SET "tenantId"=parent."tenantId"
FROM "SignatureRequest" parent
WHERE child."requestId"=parent.id AND child."tenantId" IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SignatureRequest" WHERE "tenantId" IS NULL)
     OR EXISTS (SELECT 1 FROM "SignatureRecipient" WHERE "tenantId" IS NULL)
     OR EXISTS (SELECT 1 FROM "SignatureField" WHERE "tenantId" IS NULL)
     OR EXISTS (SELECT 1 FROM "SignatureFieldResponse" WHERE "tenantId" IS NULL)
     OR EXISTS (SELECT 1 FROM "SignatureEvent" WHERE "tenantId" IS NULL)
     OR EXISTS (SELECT 1 FROM "ApprovalStep" WHERE "tenantId" IS NULL)
  THEN
    RAISE EXCEPTION 'Signing hardening aborted: unresolved tenant ownership exists';
  END IF;
END $$;

ALTER TABLE "SignatureRequest" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureRecipient" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureField" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureFieldResponse" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ApprovalStep" ALTER COLUMN "tenantId" SET NOT NULL;

ALTER TABLE "SignatureRequest"
  ADD COLUMN IF NOT EXISTS "identityPolicy" text NOT NULL DEFAULT 'ES1_LINK',
  ADD COLUMN IF NOT EXISTS "assuranceLevel" text NOT NULL DEFAULT 'ES-1',
  ADD COLUMN IF NOT EXISTS "sourceContextJson" jsonb,
  ADD COLUMN IF NOT EXISTS "canonicalSourceHash" text,
  ADD COLUMN IF NOT EXISTS "workflowHash" text,
  ADD COLUMN IF NOT EXISTS "releaseId" text,
  ADD COLUMN IF NOT EXISTS "consentVersion" text NOT NULL DEFAULT 'historic-electronic-consent',
  ADD COLUMN IF NOT EXISTS "stateVersion" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "completionLeaseOwner" text,
  ADD COLUMN IF NOT EXISTS "completionLeaseExpiresAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "failedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "failureCode" text;

ALTER TABLE "SignatureRecipient"
  ADD COLUMN IF NOT EXISTS "tokenCiphertext" text,
  ADD COLUMN IF NOT EXISTS "tokenIssuedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "tokenExpiresAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "tokenRevokedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "firstViewedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "authMethod" text,
  ADD COLUMN IF NOT EXISTS "assuranceLevel" text,
  ADD COLUMN IF NOT EXISTS "authVerifiedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "authTransactionId" text;

ALTER TABLE "ApprovalStep"
  ADD COLUMN IF NOT EXISTS "tokenCiphertext" text,
  ADD COLUMN IF NOT EXISTS "tokenIssuedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "tokenExpiresAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "tokenRevokedAt" timestamptz;

ALTER TABLE "SignatureEvent"
  ADD COLUMN IF NOT EXISTS "sequence" bigint,
  ADD COLUMN IF NOT EXISTS "prevHash" text,
  ADD COLUMN IF NOT EXISTS "payloadHash" text,
  ADD COLUMN IF NOT EXISTS "eventHash" text,
  ADD COLUMN IF NOT EXISTS "producer" text NOT NULL DEFAULT 'denagocrm',
  ADD COLUMN IF NOT EXISTS "releaseId" text,
  ADD COLUMN IF NOT EXISTS "schemaVersion" integer NOT NULL DEFAULT 1;

-- Preserve existing links while removing plaintext capability values from the DB:
-- a historic URL still hashes to the migrated digest. A later send/reminder rotates
-- it into a recoverable AES-GCM vault copy managed by the application.
UPDATE "SignatureRecipient"
SET token=encode(digest(token,'sha256'),'hex'),
    "tokenIssuedAt"=COALESCE("tokenIssuedAt","createdAt"),
    "tokenExpiresAt"=COALESCE("tokenExpiresAt", GREATEST(now()+interval '30 days',"createdAt"+interval '30 days'));

UPDATE "ApprovalStep"
SET token=encode(digest(token,'sha256'),'hex'),
    "tokenIssuedAt"=COALESCE("tokenIssuedAt","createdAt"),
    "tokenExpiresAt"=COALESCE("tokenExpiresAt", GREATEST(now()+interval '30 days',"createdAt"+interval '30 days'));

-- Historic requests get an explicit, non-fabricated migration snapshot marker.
-- Their existing snapshot remains the canonical source; no certificate facts are
-- invented. Open rows that lack any snapshot cannot safely complete and are gated.
UPDATE "SignatureRequest"
SET "sourceContextJson"=COALESCE("sourceContextJson",jsonb_build_object('historicMigration',true)),
    "canonicalSourceHash"=COALESCE("canonicalSourceHash",encode(digest(COALESCE("snapshotJson"::text,'null'),'sha256'),'hex')),
    "releaseId"=COALESCE("releaseId",'historic-migration'),
    "workflowHash"=COALESCE("workflowHash",CASE WHEN "workflowGraphJson" IS NULL THEN NULL ELSE encode(digest("workflowGraphJson"::text,'sha256'),'hex') END)
WHERE "snapshotJson" IS NOT NULL;

UPDATE "SignatureRequest"
SET status='failed_manual_intervention',
    "failureCode"='historic_envelope_missing_frozen_snapshot',
    "failedAt"=now()
WHERE "snapshotJson" IS NULL
  AND status NOT IN ('completed','declined','voided','expired','rejected');

-- Composite uniqueness is required before tenant-aware foreign keys can be added.
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRequest_tenant_id_key" ON "SignatureRequest"("tenantId",id);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureRecipient_tenant_id_key" ON "SignatureRecipient"("tenantId",id);
CREATE UNIQUE INDEX IF NOT EXISTS "SignatureField_tenant_id_key" ON "SignatureField"("tenantId",id);

-- Existing cross-row tenant consistency.
ALTER TABLE "SignatureRecipient" DROP CONSTRAINT IF EXISTS "SignatureRecipient_tenant_request_fkey";
ALTER TABLE "SignatureRecipient" ADD CONSTRAINT "SignatureRecipient_tenant_request_fkey"
  FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_tenant_request_fkey";
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_tenant_request_fkey"
  FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SignatureField" DROP CONSTRAINT IF EXISTS "SignatureField_tenant_recipient_fkey";
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE NO ACTION NOT VALID;
ALTER TABLE "SignatureFieldResponse" DROP CONSTRAINT IF EXISTS "SignatureFieldResponse_tenant_field_fkey";
ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_tenant_field_fkey"
  FOREIGN KEY ("tenantId","fieldId") REFERENCES "SignatureField"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SignatureFieldResponse" DROP CONSTRAINT IF EXISTS "SignatureFieldResponse_tenant_recipient_fkey";
ALTER TABLE "SignatureFieldResponse" ADD CONSTRAINT "SignatureFieldResponse_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SignatureEvent" DROP CONSTRAINT IF EXISTS "SignatureEvent_tenant_request_fkey";
ALTER TABLE "SignatureEvent" ADD CONSTRAINT "SignatureEvent_tenant_request_fkey"
  FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SignatureEvent" DROP CONSTRAINT IF EXISTS "SignatureEvent_tenant_recipient_fkey";
ALTER TABLE "SignatureEvent" ADD CONSTRAINT "SignatureEvent_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE NO ACTION NOT VALID;
ALTER TABLE "ApprovalStep" DROP CONSTRAINT IF EXISTS "ApprovalStep_tenant_request_fkey";
ALTER TABLE "ApprovalStep" ADD CONSTRAINT "ApprovalStep_tenant_request_fkey"
  FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
