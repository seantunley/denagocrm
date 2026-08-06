-- =============================================================================
-- SIGNING TRUST PLATFORM
-- =============================================================================
-- Durable completion jobs, immutable legal-artifact custody, explicit signing
-- tenancy, bearer-link revocation and optional step-up signer identity.
--
-- This migration is additive first, backfills under the RLS bypass, then narrows
-- the signing cluster to NOT NULL tenant ownership. It is replay-safe: tables,
-- columns, indexes, policies and triggers are all guarded or replaced.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
SET app.bypass_rls = 'on';

-- ── Explicit tenant ownership -------------------------------------------------
ALTER TABLE "SignatureRequest" ADD COLUMN IF NOT EXISTS "identityMode" TEXT NOT NULL DEFAULT 'link';
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "identityVerifiedAt" TIMESTAMP(3);
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "identityMethod" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "identityEvidenceHash" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "tokenCiphertext" TEXT;
ALTER TABLE "SignatureRecipient" ADD COLUMN IF NOT EXISTS "tokenRevokedAt" TIMESTAMP(3);
ALTER TABLE "ApprovalStep" ADD COLUMN IF NOT EXISTS "tokenCiphertext" TEXT;
ALTER TABLE "ApprovalStep" ADD COLUMN IF NOT EXISTS "tokenRevokedAt" TIMESTAMP(3);

UPDATE "SignatureRequest" r
SET "tenantId" = COALESCE(
  r."tenantId",
  (SELECT d."tenantId" FROM "Document" d WHERE d."id" = r."documentId"),
  (SELECT q."tenantId" FROM "Quote" q WHERE q."id" = r."quoteId"),
  (SELECT j."tenantId" FROM "JobCard" j WHERE j."id" = r."jobCardId"),
  (SELECT c."tenantId" FROM "Contact" c WHERE c."id" = r."contactId"),
  'tenant_denago_cpt'
)
WHERE r."tenantId" IS NULL;

UPDATE "SignatureRecipient" c SET "tenantId" = p."tenantId"
FROM "SignatureRequest" p WHERE c."requestId" = p."id" AND c."tenantId" IS NULL;
UPDATE "SignatureField" c SET "tenantId" = p."tenantId"
FROM "SignatureRequest" p WHERE c."requestId" = p."id" AND c."tenantId" IS NULL;
UPDATE "SignatureFieldResponse" c SET "tenantId" = p."tenantId"
FROM "SignatureRecipient" p WHERE c."recipientId" = p."id" AND c."tenantId" IS NULL;
UPDATE "SignatureEvent" c SET "tenantId" = p."tenantId"
FROM "SignatureRequest" p WHERE c."requestId" = p."id" AND c."tenantId" IS NULL;
UPDATE "ApprovalStep" c SET "tenantId" = p."tenantId"
FROM "SignatureRequest" p WHERE c."requestId" = p."id" AND c."tenantId" IS NULL;

ALTER TABLE "SignatureRequest" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureRecipient" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureField" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureFieldResponse" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "SignatureEvent" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "ApprovalStep" ALTER COLUMN "tenantId" SET NOT NULL;

-- Database-side stamping closes the off/monitor-mode hole. Children derive their
-- owner from the request rather than trusting a caller-supplied tenant.
--
-- FAILS CLOSED, with no default tenant. An earlier draft resolved an unknown
-- tenant to 'tenant_denago_cpt'. That is defensible in a one-time backfill of
-- rows we know are Denago's, but not in a permanent trigger: this is a
-- white-label product onboarding other companies, so a trigger that quietly
-- assigns unscoped inserts to Denago turns every future scope bug into another
-- tenant's contract filed under Denago — the exact cross-tenant contamination
-- the tenantId column exists to prevent. Refusing the write is recoverable; a
-- silently mis-owned signing envelope is not.
CREATE OR REPLACE FUNCTION signing_stamp_request_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" IS NULL THEN
    NEW."tenantId" := NULLIF(current_setting('app.current_tenant', true), '');
  END IF;
  IF NEW."tenantId" IS NULL THEN
    RAISE EXCEPTION 'SignatureRequest requires an owning tenant (no app.current_tenant in scope)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SignatureRequest_stamp_tenant" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_stamp_tenant"
BEFORE INSERT ON "SignatureRequest" FOR EACH ROW EXECUTE FUNCTION signing_stamp_request_tenant();

CREATE OR REPLACE FUNCTION signing_stamp_child_tenant() RETURNS trigger AS $$
DECLARE parent_tenant TEXT;
BEGIN
  SELECT "tenantId" INTO parent_tenant FROM "SignatureRequest" WHERE "id" = NEW."requestId";
  IF parent_tenant IS NULL THEN RAISE EXCEPTION 'Signing child has no tenant-owned request'; END IF;
  IF NEW."tenantId" IS NOT NULL AND NEW."tenantId" <> parent_tenant THEN
    RAISE EXCEPTION 'Signing child tenant does not match request tenant';
  END IF;
  NEW."tenantId" := parent_tenant;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['SignatureRecipient','SignatureField','SignatureEvent','ApprovalStep'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_stamp_tenant', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION signing_stamp_child_tenant()', t || '_stamp_tenant', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION signing_stamp_response_tenant() RETURNS trigger AS $$
DECLARE recipient_tenant TEXT;
BEGIN
  SELECT "tenantId" INTO recipient_tenant FROM "SignatureRecipient" WHERE "id" = NEW."recipientId";
  IF recipient_tenant IS NULL THEN RAISE EXCEPTION 'Signature response has no tenant-owned recipient'; END IF;
  IF NEW."tenantId" IS NOT NULL AND NEW."tenantId" <> recipient_tenant THEN
    RAISE EXCEPTION 'Signature response tenant does not match recipient tenant';
  END IF;
  NEW."tenantId" := recipient_tenant;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureFieldResponse_stamp_tenant" ON "SignatureFieldResponse";
CREATE TRIGGER "SignatureFieldResponse_stamp_tenant"
BEFORE INSERT ON "SignatureFieldResponse" FOR EACH ROW EXECUTE FUNCTION signing_stamp_response_tenant();

-- Signing-related Documents must also be owned even while app enforcement is off.
CREATE OR REPLACE FUNCTION signing_stamp_document_tenant() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" IS NULL AND NEW."tag" IN ('for-signing','signed') THEN
    NEW."tenantId" := COALESCE(
      (SELECT "tenantId" FROM "Quote" WHERE "id" = NEW."quoteId"),
      (SELECT "tenantId" FROM "JobCard" WHERE "id" = NEW."jobCardId"),
      (SELECT "tenantId" FROM "Contact" WHERE "id" = NEW."contactId"),
      NULLIF(current_setting('app.current_tenant', true), '')
    );
    -- FAILS CLOSED, exactly as signing_stamp_request_tenant does. This branch
    -- used to end in 'tenant_denago_cpt', so an unscoped Document tagged
    -- for-signing or signed was quietly filed under Denago — the same
    -- cross-tenant contamination the request trigger was fixed to prevent,
    -- surviving one function away because the test only inspected the other one.
    IF NEW."tenantId" IS NULL THEN
      RAISE EXCEPTION 'Signing document requires an owning tenant (no app.current_tenant in scope)';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Document_stamp_signing_tenant" ON "Document";
CREATE TRIGGER "Document_stamp_signing_tenant"
BEFORE INSERT ON "Document" FOR EACH ROW EXECUTE FUNCTION signing_stamp_document_tenant();

-- ── Bearer-token revocation ---------------------------------------------------
-- The token columns themselves are converted to digests by the later
-- 20260805235000_signing_token_vault migration, which is the single place that
-- decides how a capability is stored. Nothing here writes or derives a token.

CREATE OR REPLACE FUNCTION signing_revoke_request_tokens() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('completed','declined','expired','voided','rejected')
     AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    -- Revocation is `tokenRevokedAt`, NOT a rewritten token.
    --
    -- This used to overwrite the capability with 'revoked_<uuid>'. Once the
    -- token column holds a SHA-256 digest and a trigger enforces that format,
    -- such a value is refused — and because this fires on the SAME transaction
    -- as the status change, the refusal rolled back the whole completion. Every
    -- attempt to complete, decline, void, expire or reject a request would have
    -- failed. Blanking the digest is also self-defeating: the stored value is
    -- already one-way, so scrambling it protects nothing and destroys the only
    -- link between a delivered URL and the row it belonged to.
    UPDATE "SignatureRecipient"
       SET "tokenRevokedAt" = COALESCE("tokenRevokedAt", now())
     WHERE "requestId" = NEW."id" AND "tokenRevokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureRequest_revoke_tokens" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_revoke_tokens" AFTER UPDATE OF "status" ON "SignatureRequest"
FOR EACH ROW EXECUTE FUNCTION signing_revoke_request_tokens();

CREATE OR REPLACE FUNCTION signing_revoke_approval_token() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('approved','rejected') AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    -- Same reasoning as the recipient trigger above: mark it revoked, never
    -- rewrite the digest into a value the storage guard refuses.
    NEW."tokenRevokedAt" := COALESCE(NEW."tokenRevokedAt", now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "ApprovalStep_revoke_token" ON "ApprovalStep";
CREATE TRIGGER "ApprovalStep_revoke_token" BEFORE UPDATE OF "status" ON "ApprovalStep"
FOR EACH ROW EXECUTE FUNCTION signing_revoke_approval_token();

-- ── Optional step-up identity -------------------------------------------------
CREATE TABLE IF NOT EXISTS "SigningIdentityChallenge" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL DEFAULT 'sign',
  -- Which contact route the code was sent down: 'email' or 'sms'. Recorded
  -- because it is evidence — the certificate has to be able to say what was
  -- actually proven, and "a code sent to the mobile number on file" is a
  -- different assertion from "a code sent to the email address on file".
  "channel" TEXT NOT NULL DEFAULT 'email',
  -- Digest of the destination the code went to, never the destination itself.
  -- Lets a verification prove the code was sent to the address/number that was
  -- on file at the time, without keeping a second copy of the signer's contact
  -- details in a table that exists to hold secrets.
  "destinationHash" TEXT,
  "codeHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SigningIdentityChallenge_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SigningIdentityChallenge_recipient_idx" ON "SigningIdentityChallenge"("tenantId","recipientId","createdAt");
DO $$ BEGIN
  ALTER TABLE "SigningIdentityChallenge" ADD CONSTRAINT "SigningIdentityChallenge_recipient_fkey"
    FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId","id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "SigningIdentityChallenge" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SigningIdentityChallenge_tenant_isolation" ON "SigningIdentityChallenge";
CREATE POLICY "SigningIdentityChallenge_tenant_isolation" ON "SigningIdentityChallenge"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "SigningIdentityChallenge" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION signing_enforce_identity() RETURNS trigger AS $$
DECLARE required_mode TEXT;
BEGIN
  IF NEW."status" = 'signed' AND OLD."status" IS DISTINCT FROM 'signed' THEN
    SELECT "identityMode" INTO required_mode FROM "SignatureRequest" WHERE "id" = NEW."requestId";
    IF required_mode <> 'link' AND NEW."identityVerifiedAt" IS NULL THEN
      RAISE EXCEPTION 'Signer identity verification required (%).', required_mode USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureRecipient_enforce_identity" ON "SignatureRecipient";
CREATE TRIGGER "SignatureRecipient_enforce_identity" BEFORE UPDATE OF "status" ON "SignatureRecipient"
FOR EACH ROW EXECUTE FUNCTION signing_enforce_identity();

-- ── Durable transactional signing jobs ---------------------------------------
CREATE TABLE IF NOT EXISTS "SigningJob" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "jobType" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "lastError" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SigningJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SigningJob_idempotency_key" ON "SigningJob"("tenantId","idempotencyKey");
CREATE INDEX IF NOT EXISTS "SigningJob_queue_idx" ON "SigningJob"("tenantId","status","availableAt");
CREATE INDEX IF NOT EXISTS "SigningJob_request_idx" ON "SigningJob"("tenantId","requestId");
DO $$ BEGIN
  ALTER TABLE "SigningJob" ADD CONSTRAINT "SigningJob_request_fkey"
    FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "SigningJob" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "SigningJob_tenant_isolation" ON "SigningJob";
CREATE POLICY "SigningJob_tenant_isolation" ON "SigningJob"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "SigningJob" FORCE ROW LEVEL SECURITY;

-- ── Immutable legal-artifact custody -----------------------------------------
CREATE TABLE IF NOT EXISTS "LegalArtifact" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "documentId" TEXT,
  "storageRef" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "sizeBytes" INTEGER,
  "retentionClass" TEXT NOT NULL DEFAULT 'contract-7y',
  "retainUntil" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '7 years'),
  "legalHold" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegalArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "LegalArtifact_request_key" ON "LegalArtifact"("tenantId","requestId");
CREATE UNIQUE INDEX IF NOT EXISTS "LegalArtifact_storage_key" ON "LegalArtifact"("tenantId","storageRef");
DO $$ BEGIN
  ALTER TABLE "LegalArtifact" ADD CONSTRAINT "LegalArtifact_request_fkey"
    FOREIGN KEY ("tenantId","requestId") REFERENCES "SignatureRequest"("tenantId","id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "LegalArtifact" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LegalArtifact_tenant_isolation" ON "LegalArtifact";
CREATE POLICY "LegalArtifact_tenant_isolation" ON "LegalArtifact"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "LegalArtifact" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "LegalArtifactValidation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "artifactId" TEXT NOT NULL,
  "observedSha256" TEXT,
  "sizeBytes" INTEGER,
  "certificateFingerprint" TEXT,
  "manifestHash" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "valid" BOOLEAN NOT NULL,
  "errors" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "appCommit" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LegalArtifactValidation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "LegalArtifactValidation_artifact_idx" ON "LegalArtifactValidation"("tenantId","artifactId","createdAt");
DO $$ BEGIN
  ALTER TABLE "LegalArtifactValidation" ADD CONSTRAINT "LegalArtifactValidation_artifact_fkey"
    FOREIGN KEY ("artifactId") REFERENCES "LegalArtifact"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "LegalArtifactValidation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "LegalArtifactValidation_tenant_isolation" ON "LegalArtifactValidation";
CREATE POLICY "LegalArtifactValidation_tenant_isolation" ON "LegalArtifactValidation"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "tenantId" = current_setting('app.current_tenant', true));
ALTER TABLE "LegalArtifactValidation" FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION signing_immutable_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a new evidence record instead', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "LegalArtifact_immutable" ON "LegalArtifact";
CREATE TRIGGER "LegalArtifact_immutable" BEFORE UPDATE OR DELETE ON "LegalArtifact"
FOR EACH ROW EXECUTE FUNCTION signing_immutable_row();
DROP TRIGGER IF EXISTS "LegalArtifactValidation_immutable" ON "LegalArtifactValidation";
CREATE TRIGGER "LegalArtifactValidation_immutable" BEFORE UPDATE OR DELETE ON "LegalArtifactValidation"
FOR EACH ROW EXECUTE FUNCTION signing_immutable_row();

CREATE OR REPLACE FUNCTION signing_protect_document() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "LegalArtifact" a WHERE a."documentId" = OLD."id") THEN
    IF TG_OP = 'DELETE' OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
      RAISE EXCEPTION 'A sealed legal artifact cannot be moved to Trash or deleted' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Document_protect_legal_artifact" ON "Document";
CREATE TRIGGER "Document_protect_legal_artifact" BEFORE UPDATE OF "deletedAt" OR DELETE ON "Document"
FOR EACH ROW EXECUTE FUNCTION signing_protect_document();

-- The request transition is the transactional outbox boundary. The jobs and the
-- immutable custody row commit with the completed state, not after it.
CREATE OR REPLACE FUNCTION signing_enqueue_completion() RETURNS trigger AS $$
DECLARE artifact_id TEXT;
DECLARE recipient_row RECORD;
BEGIN
  IF NEW."status" = 'completed' AND OLD."status" IS DISTINCT FROM 'completed'
     AND NEW."signedPdfRef" IS NOT NULL AND NEW."signedPdfHash" IS NOT NULL THEN
    artifact_id := 'la_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO "LegalArtifact" (
      "id","tenantId","requestId","documentId","storageRef","sha256","sizeBytes"
    ) VALUES (
      artifact_id, NEW."tenantId", NEW."id", NEW."signedDocId", NEW."signedPdfRef", NEW."signedPdfHash",
      (SELECT "sizeBytes" FROM "Document" WHERE "id" = NEW."signedDocId")
    ) ON CONFLICT ("tenantId","requestId") DO NOTHING;

    INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
    VALUES
      ('sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."id", 'post_completion', 'post:' || NEW."id", '{}'::jsonb),
      ('sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."id", 'artifact_verify', 'verify:' || NEW."id", '{}'::jsonb)
    ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;

    FOR recipient_row IN SELECT "id" FROM "SignatureRecipient" WHERE "requestId" = NEW."id" AND "email" IS NOT NULL LOOP
      INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
      VALUES (
        'sj_' || replace(gen_random_uuid()::text, '-', ''), NEW."tenantId", NEW."id", 'completion_email',
        'email:' || NEW."id" || ':' || recipient_row."id",
        jsonb_build_object('recipientId', recipient_row."id")
      ) ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "SignatureRequest_enqueue_completion" ON "SignatureRequest";
CREATE TRIGGER "SignatureRequest_enqueue_completion" AFTER UPDATE OF "status" ON "SignatureRequest"
FOR EACH ROW EXECUTE FUNCTION signing_enqueue_completion();

-- Existing completed artifacts enter custody immediately. Only genuinely
-- stranded requests get delivery/effect jobs; successful historical completions
-- get verification only.
INSERT INTO "LegalArtifact" ("id","tenantId","requestId","documentId","storageRef","sha256","sizeBytes")
SELECT 'la_' || replace(gen_random_uuid()::text, '-', ''), r."tenantId", r."id", r."signedDocId", r."signedPdfRef", r."signedPdfHash", d."sizeBytes"
FROM "SignatureRequest" r LEFT JOIN "Document" d ON d."id" = r."signedDocId"
WHERE r."status" = 'completed' AND r."signedPdfRef" IS NOT NULL AND r."signedPdfHash" IS NOT NULL
ON CONFLICT ("tenantId","requestId") DO NOTHING;

INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
SELECT 'sj_' || replace(gen_random_uuid()::text, '-', ''), a."tenantId", a."requestId", 'artifact_verify', 'verify:' || a."requestId", '{}'::jsonb
FROM "LegalArtifact" a
ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;

INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
SELECT 'sj_' || replace(gen_random_uuid()::text, '-', ''), r."tenantId", r."id", 'post_completion', 'post:' || r."id", '{}'::jsonb
FROM "SignatureRequest" r
WHERE r."status" = 'completed'
  AND NOT EXISTS (SELECT 1 FROM "SignatureEvent" e WHERE e."requestId" = r."id" AND e."type" = 'completed')
ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;

INSERT INTO "SigningJob" ("id","tenantId","requestId","jobType","idempotencyKey","payload")
SELECT 'sj_' || replace(gen_random_uuid()::text, '-', ''), r."tenantId", r."id", 'completion_email',
       'email:' || r."id" || ':' || p."id", jsonb_build_object('recipientId', p."id")
FROM "SignatureRequest" r JOIN "SignatureRecipient" p ON p."requestId" = r."id"
WHERE r."status" = 'completed' AND p."email" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "SignatureEvent" e WHERE e."requestId" = r."id" AND e."type" = 'completed')
ON CONFLICT ("tenantId","idempotencyKey") DO NOTHING;

RESET app.bypass_rls;
