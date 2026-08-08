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

test("the backfill never queues an email to a customer", () => {
  // The trigger queues completion emails for completions that happen from now
  // on. The BACKFILL must not, and the difference is not academic: production
  // has one qualifying request — Quote Q-1010, completed three days before this
  // was written, already downloaded — so deploying the backfill would have
  // emailed two customers a contract out of the blue.
  //
  // `completedEmailSentAt` is no protection: this migration ADDS that column, so
  // on deploy it is empty and every recipient reads as never-notified.
  //
  // A schema migration is not the place to decide to contact customers. The
  // internal recovery (post_completion) still runs, and a genuinely missed
  // notification is a "Resend" in the UI — a person's call.
  // Anchored on the backfill section, not on the first INSERT — the trigger
  // body contains an identical-looking one, and slicing from there would sweep
  // the trigger's (correct) completion_email into the assertion.
  const backfill = migration.slice(migration.indexOf("-- Existing completed artifacts enter custody"));
  assert.ok(backfill.length > 0, "the backfill section must still be findable");
  assert.doesNotMatch(backfill, /'completion_email'/);
  assert.match(backfill, /DELIBERATELY NOT BACKFILLED: completion emails/);
  // The internal recovery is still there — this is a narrowing, not a removal.
  assert.match(backfill, /'post_completion'/);
  assert.match(backfill, /'artifact_verify'/);
});

test("the signing cluster is tenant-owned even before application enforcement", () => {
  // NOT NULL is DEFERRED, not forgotten. It shipped once and took production
  // down: the requirement can only hold if every row the signing tables point at
  // carries a tenant, and with `tenantEnforcing()` hard-coded false nothing
  // stamps them. Asserting its absence here so it cannot come back on its own,
  // ahead of the write-time stamping that makes it keepable.
  for (const table of [
    "SignatureRequest",
    "SignatureRecipient",
    "SignatureField",
    "SignatureFieldResponse",
    "SignatureEvent",
    "ApprovalStep",
  ]) {
    assert.doesNotMatch(
      migration,
      new RegExp(`ALTER TABLE "${table}" ALTER COLUMN "tenantId" SET NOT NULL`),
      `${table} NOT NULL is unkeepable until writes are stamped — see docs/TENANT-ENFORCEMENT-PREREQUISITES.md`,
    );
  }
  // What DOES hold today: the historic rows are stamped, and new rows inherit
  // from their request rather than from a guess.
  assert.match(migration, /Finish the tenant backfill the dormant stamper never did/);
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
  // The evidence hash is written through the typed client now rather than raw
  // SQL, so assert the FIELD is set rather than the shape of the statement that
  // sets it — otherwise this fails on a refactor that changed nothing about the
  // property being protected.
  assert.match(identity, /identityEvidenceHash/);
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
    // The verifier names the missing table through a template placeholder, so
    // the source text is `${required}` and never the table name. The original
    // assertion searched for the interpolated result and so could not pass for
    // any input — assert that the table is in the required LIST instead, which
    // is the thing that actually makes the backup refuse to verify without it.
    assert.match(
      backup,
      new RegExp(`for \\(const required of \\[[^\\]]*"${table}"`, "s"),
      `${table} is not in backup verification's required list`,
    );
  }
  assert.match(backup, /Missing signing trust table: \$\{required\}/);
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
  // The shared, timing-safe, fails-closed-without-CRON_SECRET helper rather than
  // a hand-rolled `!== \`Bearer ${secret}\``, which this previously asserted and
  // which is neither of those things.
  assert.match(cron, /isAuthorizedCron\(req\)/);
  assert.doesNotMatch(cron, /Bearer \$\{secret\}/);
  assert.match(cron, /runCronPerTenant/);
  assert.match(cron, /tenantId \?\? DEFAULT_TENANT_ID/);
  assert.match(read("vercel.json"), /\/api\/cron\/signing-jobs/);
});
