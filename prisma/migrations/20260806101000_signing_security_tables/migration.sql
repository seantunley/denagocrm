-- Durable custody, orchestration, identity and legal-evidence structures.

CREATE TABLE IF NOT EXISTS "SigningUploadIntent" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text,
  "plannedObjectKey" text NOT NULL,
  "originalName" text NOT NULL,
  "mimeType" text NOT NULL,
  "objectRef" text,
  sha256 text,
  "sizeBytes" bigint,
  status text NOT NULL DEFAULT 'uploading',
  "lastError" text,
  "uploadedAt" timestamptz,
  "registeredAt" timestamptz,
  "settledAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenantId","plannedObjectKey")
);

CREATE TABLE IF NOT EXISTS "SigningArtifact" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text,
  kind text NOT NULL,
  "objectRef" text NOT NULL,
  sha256 text,
  "sizeBytes" bigint,
  state text NOT NULL DEFAULT 'uploaded',
  "settlementNotBefore" timestamptz NOT NULL DEFAULT (now()+interval '24 hours'),
  "referencedAt" timestamptz,
  "sealedAt" timestamptz,
  "lastVerifiedAt" timestamptz,
  "lastError" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenantId","objectRef",kind)
);

CREATE TABLE IF NOT EXISTS "LegalArtifact" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL,
  "artifactVersion" integer NOT NULL DEFAULT 1,
  "documentId" text,
  "objectRef" text NOT NULL,
  sha256 text NOT NULL,
  "sizeBytes" bigint NOT NULL,
  "certificateFingerprint" text NOT NULL,
  "certificateChainJson" jsonb NOT NULL,
  "keyId" text,
  "trustPolicy" text NOT NULL,
  "timestampTokenRef" text,
  "validationReportJson" jsonb NOT NULL,
  "retentionClass" text NOT NULL,
  "retainUntil" timestamptz NOT NULL,
  "legalHold" boolean NOT NULL DEFAULT false,
  "legalHoldReason" text,
  "legalHoldAt" timestamptz,
  "destroyedAt" timestamptz,
  "destroyedById" text,
  "destructionCertificateJson" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenantId","envelopeId","artifactVersion"),
  UNIQUE ("tenantId","objectRef")
);

CREATE TABLE IF NOT EXISTS "SigningOutboxJob" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text,
  "recipientId" text,
  "jobType" text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  "idempotencyKey" text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz NOT NULL DEFAULT now(),
  "leaseOwner" text,
  "leaseExpiresAt" timestamptz,
  "lastError" text,
  "completedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "SigningDelivery" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL,
  "recipientId" text,
  channel text NOT NULL,
  purpose text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  "idempotencyKey" text NOT NULL UNIQUE,
  "providerMessageId" text,
  "lastError" text,
  "queuedAt" timestamptz NOT NULL DEFAULT now(),
  "sentAt" timestamptz,
  "deliveredAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "SigningIdentityChallenge" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL,
  "recipientId" text NOT NULL,
  method text NOT NULL,
  "destinationHash" text NOT NULL,
  "secretHash" text NOT NULL,
  "sessionHash" text,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  "maxAttempts" integer NOT NULL DEFAULT 5,
  "expiresAt" timestamptz NOT NULL,
  "verifiedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "SigningEvidenceAnchor" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL,
  sequence bigint NOT NULL,
  "eventHash" text NOT NULL,
  "rootHash" text NOT NULL,
  provider text NOT NULL,
  "anchorRef" text,
  "anchoredAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("tenantId","envelopeId","rootHash")
);

CREATE TABLE IF NOT EXISTS "LegalArtifactDestructionRequest" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "artifactId" text NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  "requestedById" text NOT NULL,
  "approvedById" text,
  "executedById" text,
  "requestedAt" timestamptz NOT NULL DEFAULT now(),
  "approvedAt" timestamptz,
  "executedAt" timestamptz,
  "certificateJson" jsonb
);

CREATE TABLE IF NOT EXISTS "SigningRecoveryAction" (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "tenantId" text NOT NULL REFERENCES "Tenant"(id) ON DELETE RESTRICT,
  "envelopeId" text NOT NULL,
  reason text NOT NULL,
  action text NOT NULL,
  "operatorId" text NOT NULL,
  "beforeJson" jsonb,
  "afterJson" jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "SigningUploadIntent_settlement_idx" ON "SigningUploadIntent"(status,"uploadedAt");
CREATE INDEX IF NOT EXISTS "SigningArtifact_settlement_idx" ON "SigningArtifact"(state,"settlementNotBefore");
CREATE INDEX IF NOT EXISTS "SigningArtifact_envelope_idx" ON "SigningArtifact"("tenantId","envelopeId",kind);
CREATE INDEX IF NOT EXISTS "LegalArtifact_retention_idx" ON "LegalArtifact"("tenantId","legalHold","retainUntil");
CREATE INDEX IF NOT EXISTS "LegalArtifact_envelope_idx" ON "LegalArtifact"("tenantId","envelopeId");
CREATE INDEX IF NOT EXISTS "SigningOutboxJob_due_idx" ON "SigningOutboxJob"(status,"availableAt");
CREATE INDEX IF NOT EXISTS "SigningOutboxJob_tenant_idx" ON "SigningOutboxJob"("tenantId",status,"availableAt");
CREATE INDEX IF NOT EXISTS "SigningOutboxJob_envelope_idx" ON "SigningOutboxJob"("envelopeId","createdAt");
CREATE INDEX IF NOT EXISTS "SigningDelivery_envelope_idx" ON "SigningDelivery"("tenantId","envelopeId",status);
CREATE INDEX IF NOT EXISTS "SigningIdentityChallenge_active_idx" ON "SigningIdentityChallenge"("tenantId","recipientId",method,status,"expiresAt");
CREATE INDEX IF NOT EXISTS "SigningEvidenceAnchor_envelope_idx" ON "SigningEvidenceAnchor"("tenantId","envelopeId","anchoredAt");
CREATE INDEX IF NOT EXISTS "LegalArtifactDestruction_status_idx" ON "LegalArtifactDestructionRequest"("tenantId",status,"requestedAt");
CREATE INDEX IF NOT EXISTS "SigningRecoveryAction_envelope_idx" ON "SigningRecoveryAction"("tenantId","envelopeId","createdAt");

ALTER TABLE "SigningUploadIntent" ADD CONSTRAINT "SigningUploadIntent_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "SigningArtifact" ADD CONSTRAINT "SigningArtifact_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "LegalArtifact" ADD CONSTRAINT "LegalArtifact_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "SigningOutboxJob" ADD CONSTRAINT "SigningOutboxJob_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SigningOutboxJob" ADD CONSTRAINT "SigningOutboxJob_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SigningDelivery" ADD CONSTRAINT "SigningDelivery_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SigningDelivery" ADD CONSTRAINT "SigningDelivery_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE NO ACTION NOT VALID;
ALTER TABLE "SigningIdentityChallenge" ADD CONSTRAINT "SigningIdentityChallenge_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SigningIdentityChallenge" ADD CONSTRAINT "SigningIdentityChallenge_tenant_recipient_fkey"
  FOREIGN KEY ("tenantId","recipientId") REFERENCES "SignatureRecipient"("tenantId",id) ON DELETE CASCADE NOT VALID;
ALTER TABLE "SigningEvidenceAnchor" ADD CONSTRAINT "SigningEvidenceAnchor_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE RESTRICT NOT VALID;
ALTER TABLE "SigningRecoveryAction" ADD CONSTRAINT "SigningRecoveryAction_tenant_envelope_fkey"
  FOREIGN KEY ("tenantId","envelopeId") REFERENCES "SignatureRequest"("tenantId",id) ON DELETE RESTRICT NOT VALID;

CREATE UNIQUE INDEX IF NOT EXISTS "LegalArtifact_tenant_id_key" ON "LegalArtifact"("tenantId",id);
ALTER TABLE "LegalArtifactDestructionRequest" ADD CONSTRAINT "LegalArtifactDestruction_tenant_artifact_fkey"
  FOREIGN KEY ("tenantId","artifactId") REFERENCES "LegalArtifact"("tenantId",id) ON DELETE RESTRICT NOT VALID;

ALTER TABLE "SignatureRecipient" VALIDATE CONSTRAINT "SignatureRecipient_tenant_request_fkey";
ALTER TABLE "SignatureField" VALIDATE CONSTRAINT "SignatureField_tenant_request_fkey";
ALTER TABLE "SignatureField" VALIDATE CONSTRAINT "SignatureField_tenant_recipient_fkey";
ALTER TABLE "SignatureFieldResponse" VALIDATE CONSTRAINT "SignatureFieldResponse_tenant_field_fkey";
ALTER TABLE "SignatureFieldResponse" VALIDATE CONSTRAINT "SignatureFieldResponse_tenant_recipient_fkey";
ALTER TABLE "SignatureEvent" VALIDATE CONSTRAINT "SignatureEvent_tenant_request_fkey";
ALTER TABLE "SignatureEvent" VALIDATE CONSTRAINT "SignatureEvent_tenant_recipient_fkey";
ALTER TABLE "ApprovalStep" VALIDATE CONSTRAINT "ApprovalStep_tenant_request_fkey";
ALTER TABLE "SigningUploadIntent" VALIDATE CONSTRAINT "SigningUploadIntent_tenant_envelope_fkey";
ALTER TABLE "SigningArtifact" VALIDATE CONSTRAINT "SigningArtifact_tenant_envelope_fkey";
ALTER TABLE "LegalArtifact" VALIDATE CONSTRAINT "LegalArtifact_tenant_envelope_fkey";
ALTER TABLE "SigningOutboxJob" VALIDATE CONSTRAINT "SigningOutboxJob_tenant_envelope_fkey";
ALTER TABLE "SigningOutboxJob" VALIDATE CONSTRAINT "SigningOutboxJob_tenant_recipient_fkey";
ALTER TABLE "SigningDelivery" VALIDATE CONSTRAINT "SigningDelivery_tenant_envelope_fkey";
ALTER TABLE "SigningDelivery" VALIDATE CONSTRAINT "SigningDelivery_tenant_recipient_fkey";
ALTER TABLE "SigningIdentityChallenge" VALIDATE CONSTRAINT "SigningIdentityChallenge_tenant_envelope_fkey";
ALTER TABLE "SigningIdentityChallenge" VALIDATE CONSTRAINT "SigningIdentityChallenge_tenant_recipient_fkey";
ALTER TABLE "SigningEvidenceAnchor" VALIDATE CONSTRAINT "SigningEvidenceAnchor_tenant_envelope_fkey";
ALTER TABLE "LegalArtifactDestructionRequest" VALIDATE CONSTRAINT "LegalArtifactDestruction_tenant_artifact_fkey";
ALTER TABLE "SigningRecoveryAction" VALIDATE CONSTRAINT "SigningRecoveryAction_tenant_envelope_fkey";
