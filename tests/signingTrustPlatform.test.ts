import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");
const migration = read("prisma/migrations/20260805230000_signing_trust_platform/migration.sql");

test("completion creates custody and durable jobs in the database transition", () => {
  assert.match(migration, /CREATE TRIGGER "SignatureRequest_enqueue_completion"/);
  assert.match(migration, /AFTER UPDATE OF "status" ON "SignatureRequest"/);
  assert.match(migration, /INSERT INTO "LegalArtifact"/);
  assert.match(migration, /'post_completion'/);
  assert.match(migration, /'completion_email'/);
  assert.match(migration, /'artifact_verify'/);
  assert.match(migration, /ON CONFLICT \("tenantId","idempotencyKey"\) DO NOTHING/);
});

test("the signing cluster is tenant-owned even before application enforcement", () => {
  for (const table of [
    "SignatureRequest",
    "SignatureRecipient",
    "SignatureField",
    "SignatureFieldResponse",
    "SignatureEvent",
    "ApprovalStep",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ALTER COLUMN "tenantId" SET NOT NULL`));
  }
  assert.match(migration, /CREATE TRIGGER "SignatureRequest_stamp_tenant"/);
  assert.match(migration, /signing_stamp_child_tenant/);
  assert.match(migration, /signing_stamp_response_tenant/);
  assert.match(migration, /Document_stamp_signing_tenant/);
});

test("new signing support tables use FORCE RLS and tenant foreign keys", () => {
  for (const table of ["SigningIdentityChallenge", "SigningJob", "LegalArtifact", "LegalArtifactValidation"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`CREATE POLICY "${table}_tenant_isolation"`));
  }
  assert.match(migration, /SigningJob_request_fkey/);
  assert.match(migration, /LegalArtifact_request_fkey/);
  assert.match(migration, /SigningIdentityChallenge_recipient_fkey/);
});

test("sealed legal artifacts cannot enter ordinary Trash or be rewritten", () => {
  assert.match(migration, /CREATE TRIGGER "LegalArtifact_immutable" BEFORE UPDATE OR DELETE/);
  assert.match(migration, /CREATE TRIGGER "LegalArtifactValidation_immutable" BEFORE UPDATE OR DELETE/);
  assert.match(migration, /CREATE TRIGGER "Document_protect_legal_artifact"/);
  assert.match(migration, /A sealed legal artifact cannot be moved to Trash or deleted/);
});

test("higher-assurance identity is a database rule, not a UI promise", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS "SigningIdentityChallenge"/);
  assert.match(migration, /CREATE TRIGGER "SignatureRecipient_enforce_identity"/);
  assert.match(migration, /required_mode <> 'link' AND NEW\."identityVerifiedAt" IS NULL/);
  const identity = read("src/lib/signing/identity.ts");
  assert.match(identity, /createHmac|signingOtpHash/);
  assert.match(identity, /FOR UPDATE/);
  assert.match(identity, /MAX_ATTEMPTS = 5/);
  assert.match(identity, /"identityEvidenceHash"/);
});

test("terminal requests revoke bearer links", () => {
  assert.match(migration, /CREATE TRIGGER "SignatureRequest_revoke_tokens"/);
  assert.match(migration, /'completed','declined','expired','voided','rejected'/);
  assert.match(migration, /"tokenRevokedAt"/);
  const page = read("src/app/signing/[token]/page.tsx");
  assert.match(page, /\["completed", "declined", "expired", "voided", "rejected"\]/);
});

test("strict production sealing has no silent self-signed fallback", () => {
  const seal = read("src/lib/pdf/seal.ts");
  assert.match(seal, /signingSecurityMode\(\) === "strict"/);
  assert.match(seal, /assertSigningRuntimeReady\("PDF sealing"\)/);
  assert.doesNotMatch(seal, /denago-spike/);
  assert.match(seal, /fingerprintSha256/);

  const policy = read("src/lib/signing/securityPolicy.ts");
  for (const required of [
    "BLOB_PRIVATE",
    "BLOB_PRIVATE_READ_WRITE_TOKEN",
    "BUILDER_SIGN_P12_BASE64",
    "TENANT_ENFORCEMENT",
    "CRON_SECRET",
  ]) {
    assert.match(policy, new RegExp(required));
  }
});

test("portable backup includes every signing storage class and trust table", () => {
  const backup = read("src/lib/backup.ts");
  for (const ref of [
    "unsignedPdfRef",
    "signedPdfRef",
    "SignatureRecipient",
    "SignatureField",
    "LegalArtifact",
  ]) {
    assert.match(backup, new RegExp(ref));
  }
  for (const table of ["SigningJob", "SigningIdentityChallenge", "LegalArtifact", "LegalArtifactValidation"]) {
    assert.match(backup, new RegExp(`data\\.${table}`));
    assert.match(backup, new RegExp(`Missing signing trust table: \\${table}`));
  }
  assert.match(backup, /PORTABLE_BACKUP_VERSION = 3/);
});

test("durable worker is tenant explicit, leased, retryable and dead-lettered", () => {
  const worker = read("src/lib/signing/jobWorker.ts");
  assert.match(worker, /runSigningJobs\(tenantId: string/);
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /"tenantId" = \$\{/);
  assert.match(worker, /MAX_JOB_ATTEMPTS = 12/);
  assert.match(worker, /"status" = 'dead'/);
  assert.match(worker, /signing-job-dead/);
  assert.match(worker, /LegalArtifactValidation/);
  assert.match(worker, /manifestHash/);

  const cron = read("src/app/api/cron/signing-jobs/route.ts");
  assert.match(cron, /Bearer \$\{secret\}/);
  assert.match(cron, /runCronPerTenant/);
  assert.match(cron, /tenantId \?\? DEFAULT_TENANT_ID/);
  assert.match(read("vercel.json"), /\/api\/cron\/signing-jobs/);
});
