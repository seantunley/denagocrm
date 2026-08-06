import "server-only";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { sendEmail } from "@/lib/email";
import { logError } from "@/lib/errorLog";
import { runInTenantScope } from "@/lib/tenantScope";
import { configuredSigningCertificateInfo } from "@/lib/pdf/seal";
import { logSignEvent } from "./events";
import { runPostCompletion } from "./postComplete";
import { COMPLETED_EVENT, POST_COMPLETION_EVENT } from "./completionFanout";
import { sourceSignedByThisRequest } from "./recoveryScope";
import { signingSecurityMode } from "./securityPolicy";

const MAX_JOB_ATTEMPTS = 12;

type SigningJob = {
  id: string;
  tenantId: string;
  requestId: string;
  jobType: "completion_email" | "post_completion" | "artifact_verify";
  payload: Record<string, unknown>;
  attempts: number;
};

type ArtifactRow = {
  id: string;
  tenantId: string;
  requestId: string;
  documentId: string | null;
  storageRef: string;
  sha256: string;
  sizeBytes: number | null;
  retentionClass: string;
  retainUntil: Date;
  legalHold: boolean;
  createdAt: Date;
};

type CompletionRequest = {
  id: string;
  tenantId: string;
  title: string;
  quoteId: string | null;
  jobCardId: string | null;
  signedPdfRef: string | null;
  signedPdfHash: string | null;
  signedDocId: string | null;
};

export type SigningJobRun = {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
  leased: number;
};

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000);
}

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, canonical(input[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

async function claimJobs(tenantId: string, limit: number): Promise<SigningJob[]> {
  const owner = crypto.randomUUID();
  return basePrisma.$queryRaw<SigningJob[]>`
    WITH candidates AS (
      SELECT "id"
      FROM "SigningJob"
      WHERE "tenantId" = ${tenantId}
        AND "status" IN ('pending','retry')
        AND "availableAt" <= NOW()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
      ORDER BY "availableAt" ASC, "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SigningJob" j
       SET "status" = 'running',
           "leaseOwner" = ${owner},
           "leaseUntil" = NOW() + INTERVAL '10 minutes',
           "attempts" = j."attempts" + 1,
           "updatedAt" = NOW()
      FROM candidates c
     WHERE j."id" = c."id"
    RETURNING j."id", j."tenantId", j."requestId", j."jobType", j."payload", j."attempts"
  `;
}

async function claimRequestLease(job: SigningJob): Promise<string | null> {
  const owner = `job:${job.id}:${crypto.randomUUID()}`;
  const count = await basePrisma.$executeRaw`
    UPDATE "SignatureRequest"
       SET "recoveryLeaseOwner" = ${owner},
           "recoveryLeaseUntil" = NOW() + INTERVAL '10 minutes'
     WHERE "id" = ${job.requestId}
       AND "tenantId" = ${job.tenantId}
       AND ("recoveryLeaseUntil" IS NULL OR "recoveryLeaseUntil" < NOW())
  `;
  return count === 1 ? owner : null;
}

async function releaseRequestLease(job: SigningJob, owner: string): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "SignatureRequest"
       SET "recoveryLeaseOwner" = NULL, "recoveryLeaseUntil" = NULL
     WHERE "id" = ${job.requestId}
       AND "tenantId" = ${job.tenantId}
       AND "recoveryLeaseOwner" = ${owner}
  `.catch(() => 0);
}

async function eventExists(requestId: string, tenantId: string, type: string): Promise<boolean> {
  const rows = await basePrisma.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM "SignatureEvent"
      WHERE "requestId" = ${requestId} AND "tenantId" = ${tenantId} AND "type" = ${type}
    ) AS "found"
  `;
  return Boolean(rows[0]?.found);
}

async function completionRequest(job: SigningJob): Promise<CompletionRequest> {
  const rows = await basePrisma.$queryRaw<CompletionRequest[]>`
    SELECT "id", "tenantId", "title", "quoteId", "jobCardId",
           "signedPdfRef", "signedPdfHash", "signedDocId"
    FROM "SignatureRequest"
    WHERE "id" = ${job.requestId} AND "tenantId" = ${job.tenantId} AND "status" = 'completed'
    LIMIT 1
  `;
  if (!rows[0]) throw new Error("Completed signature request no longer exists in this tenant");
  return rows[0];
}

async function executeCompletionEmail(job: SigningJob): Promise<void> {
  // PR #324 writes this marker only after every addressed recipient was accepted
  // by SMTP, so a durable job created in the same completion transaction can
  // safely no-op when the inline path already finished.
  if (await eventExists(job.requestId, job.tenantId, COMPLETED_EVENT)) return;
  const recipientId = typeof job.payload.recipientId === "string" ? job.payload.recipientId : null;
  if (!recipientId) throw new Error("Completion-email job has no recipientId");

  const recipients = await basePrisma.$queryRaw<Array<{
    id: string;
    name: string;
    email: string | null;
    completedEmailSentAt: Date | null;
  }>>`
    SELECT "id", "name", "email", "completedEmailSentAt"
    FROM "SignatureRecipient"
    WHERE "id" = ${recipientId} AND "requestId" = ${job.requestId} AND "tenantId" = ${job.tenantId}
    LIMIT 1
  `;
  const recipient = recipients[0];
  if (!recipient || !recipient.email || recipient.completedEmailSentAt) return;

  const request = await completionRequest(job);
  if (!request.signedPdfRef) throw new Error("Completed request has no sealed PDF reference");
  const pdf = await readFile(request.signedPdfRef);
  const result = await sendEmail({
    to: recipient.email,
    subject: `Completed & signed: ${request.title}`,
    text: `Hi ${recipient.name},\n\nEveryone has signed "${request.title}". The final sealed PDF is attached.\n\nDenago Cape Town`,
    attachments: [{ filename: `${request.title}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  if (!result.ok) throw new Error(result.error || `SMTP did not accept ${recipient.email}`);

  await basePrisma.$executeRaw`
    UPDATE "SignatureRecipient"
       SET "completedEmailSentAt" = COALESCE("completedEmailSentAt", NOW())
     WHERE "id" = ${recipient.id} AND "tenantId" = ${job.tenantId}
  `;
}

async function reconstructOutcome(request: CompletionRequest): Promise<{ sourceSigned: boolean; wonLeadId: string | null; signedByName: string }> {
  const signers = await basePrisma.$queryRaw<Array<{ name: string; signedName: string | null }>>`
    SELECT "name", "signedName"
    FROM "SignatureRecipient"
    WHERE "requestId" = ${request.id} AND "tenantId" = ${request.tenantId}
      AND "role" <> 'viewer' AND "status" = 'signed'
    ORDER BY "order" ASC LIMIT 1
  `;
  const signedByName = signers[0]?.signedName || signers[0]?.name || "Customer";

  if (request.quoteId) {
    const quotes = await basePrisma.$queryRaw<Array<{
      signedAt: Date | null;
      signedPdfHash: string | null;
      supersededAt: Date | null;
      leadId: string | null;
    }>>`
      SELECT "signedAt", "signedPdfHash", "supersededAt", "leadId"
      FROM "Quote"
      WHERE "id" = ${request.quoteId} AND "tenantId" = ${request.tenantId} AND "deletedAt" IS NULL
      LIMIT 1
    `;
    const quote = quotes[0];
    const sourceSigned = Boolean(
      quote?.signedAt && !quote.supersededAt && sourceSignedByThisRequest(request.signedPdfHash, quote.signedPdfHash),
    );
    if (!sourceSigned || !quote?.leadId) return { sourceSigned, wonLeadId: null, signedByName };
    const leads = await basePrisma.$queryRaw<Array<{ status: string }>>`
      SELECT "status" FROM "Lead"
      WHERE "id" = ${quote.leadId} AND "tenantId" = ${request.tenantId} AND "deletedAt" IS NULL
      LIMIT 1
    `;
    return { sourceSigned, wonLeadId: leads[0]?.status === "won" ? quote.leadId : null, signedByName };
  }

  if (request.jobCardId) {
    const cards = await basePrisma.$queryRaw<Array<{ signedAt: Date | null; signedPdfHash: string | null }>>`
      SELECT "signedAt", "signedPdfHash" FROM "JobCard"
      WHERE "id" = ${request.jobCardId} AND "tenantId" = ${request.tenantId} AND "deletedAt" IS NULL
      LIMIT 1
    `;
    return {
      sourceSigned: Boolean(cards[0]?.signedAt && sourceSignedByThisRequest(request.signedPdfHash, cards[0]?.signedPdfHash)),
      wonLeadId: null,
      signedByName,
    };
  }

  return { sourceSigned: false, wonLeadId: null, signedByName };
}

async function executePostCompletion(job: SigningJob): Promise<void> {
  if (await eventExists(job.requestId, job.tenantId, COMPLETED_EVENT)) return;
  if (await eventExists(job.requestId, job.tenantId, POST_COMPLETION_EVENT)) return;
  const request = await completionRequest(job);
  const outcome = await reconstructOutcome(request);
  const result = await runPostCompletion({
    id: request.id,
    title: request.title,
    quoteId: request.quoteId,
    jobCardId: request.jobCardId,
    signedByName: outcome.signedByName,
    signedPdfHash: request.signedPdfHash,
    signedDocId: request.signedDocId,
    sourceSigned: outcome.sourceSigned,
    wonLeadId: outcome.wonLeadId,
  });
  if (!result.ok) throw new Error(result.failures.join("; "));
  await logSignEvent(request.id, { type: POST_COMPLETION_EVENT, actor: "system", metadata: { job: job.id } });
}

async function executeArtifactVerification(job: SigningJob): Promise<void> {
  const artifacts = await basePrisma.$queryRaw<ArtifactRow[]>`
    SELECT "id", "tenantId", "requestId", "documentId", "storageRef", "sha256",
           "sizeBytes", "retentionClass", "retainUntil", "legalHold", "createdAt"
    FROM "LegalArtifact"
    WHERE "requestId" = ${job.requestId} AND "tenantId" = ${job.tenantId}
    LIMIT 1
  `;
  const artifact = artifacts[0];
  if (!artifact) throw new Error("Completed request has no immutable LegalArtifact row");

  const prior = await basePrisma.$queryRaw<Array<{ valid: boolean; observedSha256: string | null }>>`
    SELECT "valid", "observedSha256" FROM "LegalArtifactValidation"
    WHERE "artifactId" = ${artifact.id} AND "tenantId" = ${artifact.tenantId}
    ORDER BY "createdAt" DESC LIMIT 1
  `;
  if (prior[0]?.valid && prior[0].observedSha256 === artifact.sha256) return;

  const bytes = await readFile(artifact.storageRef);
  const observedSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const certificate = configuredSigningCertificateInfo();
  const errors: string[] = [];
  if (observedSha256 !== artifact.sha256) errors.push("sealed PDF hash mismatch");
  if (artifact.sizeBytes !== null && artifact.sizeBytes !== bytes.length) errors.push("sealed PDF size mismatch");
  // STRICT mode, not merely "production".
  //
  // Compat mode is explicitly allowed to run without a purchased certificate —
  // it seals with a self-signed identity and marks it untrusted. Rejecting that
  // whenever NODE_ENV happened to be production meant every compat completion
  // raised an artifact_verify job that retried to dead-letter, and because the
  // final `completed` event waits for all jobs, the durable workflow never
  // reached the finished state it reports. The system spent its retries failing
  // a check its own configuration says is not required yet.
  if (signingSecurityMode() === "strict" && !certificate.trusted) {
    errors.push("PDF seal is not backed by the configured trusted certificate");
  }
  if (
    signingSecurityMode() === "strict" &&
    process.env.BLOB_PRIVATE === "true" &&
    artifact.storageRef.includes(".blob.vercel-storage.com") &&
    !artifact.storageRef.includes(".private.blob.vercel-storage.com")
  ) {
    errors.push("legal artifact is still stored in the public Blob store");
  }

  const [request, recipients, fields, responses, events] = await Promise.all([
    basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "tenantId", "title", "status", "ordering", "quoteId", "jobCardId", "contactId",
             "unsignedPdfRef", "signedPdfRef", "signedPdfHash", "sentAt", "completedAt", "createdAt",
             "identityMode", "workflowGraphJson"
      FROM "SignatureRequest" WHERE "id" = ${job.requestId} AND "tenantId" = ${job.tenantId}
    `,
    basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "name", "email", "phone", "role", "order", "status", "signedAt", "signedName",
             "viewedAt", "declinedAt", "signerIp", "signerUserAgent", "identityVerifiedAt",
             "identityMethod", "identityEvidenceHash"
      FROM "SignatureRecipient" WHERE "requestId" = ${job.requestId} AND "tenantId" = ${job.tenantId}
      ORDER BY "order", "id"
    `,
    basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "recipientId", "kind", "page", "x", "y", "width", "height", "required", "label", "value", "filledAt"
      FROM "SignatureField" WHERE "requestId" = ${job.requestId} AND "tenantId" = ${job.tenantId}
      ORDER BY "page", "y", "x", "id"
    `,
    basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT r."id", r."fieldId", r."recipientId", r."value", r."filledAt"
      FROM "SignatureFieldResponse" r
      JOIN "SignatureField" f ON f."id" = r."fieldId" AND f."tenantId" = r."tenantId"
      WHERE f."requestId" = ${job.requestId} AND r."tenantId" = ${job.tenantId}
      ORDER BY r."fieldId", r."recipientId"
    `,
    basePrisma.$queryRaw<Array<Record<string, unknown>>>`
      -- The CHAIN COLUMNS are part of the evidence, not bookkeeping. Without
      -- them the exported manifest cannot be verified by anyone: the whole point
      -- of a hash chain is that a third party can recompute it, and a bundle
      -- missing sequence/prevHash/payloadHash/eventHash is just a list of claims.
      SELECT "id", "recipientId", "type", "actor", "channel", "ip", "userAgent", "metadata", "createdAt",
             "sequence", "prevHash", "payloadHash", "eventHash"
      FROM "SignatureEvent" WHERE "requestId" = ${job.requestId} AND "tenantId" = ${job.tenantId}
      ORDER BY "createdAt", "id"
    `,
  ]);

  const manifest = {
    schema: "denago-signing-evidence/v1",
    artifact: {
      id: artifact.id,
      requestId: artifact.requestId,
      documentId: artifact.documentId,
      storageRef: artifact.storageRef,
      expectedSha256: artifact.sha256,
      observedSha256,
      sizeBytes: bytes.length,
      retentionClass: artifact.retentionClass,
      retainUntil: artifact.retainUntil,
      legalHold: artifact.legalHold,
      createdAt: artifact.createdAt,
    },
    certificate,
    request: request[0] ?? null,
    recipients,
    fields,
    responses,
    events,
  };
  const manifestJson = canonicalJson(manifest);
  const manifestHash = crypto.createHash("sha256").update(manifestJson).digest("hex");
  const validationId = `lav_${crypto.randomUUID().replace(/-/g, "")}`;
  const errorsJson = JSON.stringify(errors);
  await basePrisma.$executeRaw`
    INSERT INTO "LegalArtifactValidation"
      ("id","tenantId","artifactId","observedSha256","sizeBytes","certificateFingerprint",
       "manifestHash","manifest","valid","errors","appCommit","createdAt")
    VALUES
      (${validationId}, ${artifact.tenantId}, ${artifact.id}, ${observedSha256}, ${bytes.length},
       ${certificate.fingerprintSha256}, ${manifestHash}, ${manifestJson}::jsonb,
       ${errors.length === 0}, ${errorsJson}::jsonb, ${process.env.VERCEL_GIT_COMMIT_SHA ?? null}, NOW())
  `;

  if (errors.length) throw new Error(errors.join("; "));
}

async function executeJob(job: SigningJob): Promise<void> {
  switch (job.jobType) {
    case "completion_email":
      return executeCompletionEmail(job);
    case "post_completion":
      return executePostCompletion(job);
    case "artifact_verify":
      return executeArtifactVerification(job);
    default:
      throw new Error(`Unknown signing job type: ${String(job.jobType)}`);
  }
}

async function markCompleted(job: SigningJob): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "SigningJob"
       SET "status" = 'completed', "completedAt" = NOW(), "leaseUntil" = NULL,
           "leaseOwner" = NULL, "lastError" = NULL, "updatedAt" = NOW()
     WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
  `;
}

async function retryOrDead(job: SigningJob, error: unknown): Promise<"retry" | "dead"> {
  const message = safeMessage(error);
  const dead = job.attempts >= MAX_JOB_ATTEMPTS;
  const delayMinutes = Math.min(360, 2 ** Math.min(job.attempts, 8));
  const availableAt = new Date(Date.now() + delayMinutes * 60_000);
  await basePrisma.$executeRaw`
    UPDATE "SigningJob"
       SET "status" = ${dead ? "dead" : "retry"},
           "availableAt" = ${availableAt},
           "leaseUntil" = NULL, "leaseOwner" = NULL,
           "lastError" = ${message}, "updatedAt" = NOW()
     WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
  `;
  await logError(
    dead ? "signing-job-dead" : "signing-job-retry",
    new Error(message),
    `job ${job.id}, request ${job.requestId}`,
  ).catch(() => {});
  return dead ? "dead" : "retry";
}

async function finalizeRequestIfDone(job: SigningJob): Promise<void> {
  const rows = await basePrisma.$queryRaw<Array<{ unfinished: bigint; dead: bigint }>>`
    SELECT
      COUNT(*) FILTER (WHERE "status" <> 'completed') AS "unfinished",
      COUNT(*) FILTER (WHERE "status" = 'dead') AS "dead"
    FROM "SigningJob"
    WHERE "tenantId" = ${job.tenantId} AND "requestId" = ${job.requestId}
  `;
  if (Number(rows[0]?.unfinished ?? 1) !== 0 || Number(rows[0]?.dead ?? 1) !== 0) return;
  if (!(await eventExists(job.requestId, job.tenantId, COMPLETED_EVENT))) {
    await logSignEvent(job.requestId, {
      type: COMPLETED_EVENT,
      actor: "system",
      metadata: { durableJobs: true },
    });
  }
}

export async function runSigningJobs(tenantId: string, limit = 20): Promise<SigningJobRun> {
  if (!tenantId) throw new Error("Signing jobs require a concrete tenant id");
  return runInTenantScope({ tenantId, system: false }, async () => {
    const jobs = await claimJobs(tenantId, Math.max(1, Math.min(limit, 50)));
    const result: SigningJobRun = { claimed: jobs.length, completed: 0, retried: 0, dead: 0, leased: 0 };

    for (const job of jobs) {
      const leaseOwner = await claimRequestLease(job);
      if (!leaseOwner) {
        result.leased += 1;
        await basePrisma.$executeRaw`
          UPDATE "SigningJob" SET "status" = 'retry', "availableAt" = NOW() + INTERVAL '1 minute',
            "leaseUntil" = NULL, "leaseOwner" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
        `;
        continue;
      }

      try {
        await executeJob(job);
        await markCompleted(job);
        await finalizeRequestIfDone(job);
        result.completed += 1;
      } catch (error) {
        const state = await retryOrDead(job, error);
        result[state === "dead" ? "dead" : "retried"] += 1;
      } finally {
        await releaseRequestLease(job, leaseOwner);
      }
    }

    return result;
  });
}
