import "server-only";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { runInTenantScope } from "@/lib/tenantScope";
import { advanceAfterSignature } from "./workflow";
import { advanceWorkflow } from "@/lib/signflow/runtime";
import { notifyCreatorDeclined, notifyCreatorRejected } from "./notify";

const MAX_ATTEMPTS = 12;

type TransitionJob = {
  id: string;
  tenantId: string;
  requestId: string;
  jobType: "advance_signature" | "decline_notify" | "advance_approval";
  payload: Record<string, unknown>;
  attempts: number;
};

export type TransitionJobRun = {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
  leased: number;
};

async function claimJobs(tenantId: string, limit: number): Promise<TransitionJob[]> {
  const owner = `transition:${crypto.randomUUID()}`;
  return basePrisma.$queryRaw<TransitionJob[]>`
    WITH candidates AS (
      SELECT "id" FROM "SigningJob"
      WHERE "tenantId" = ${tenantId}
        AND "status" IN ('transition','transition_retry')
        AND "availableAt" <= NOW()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
      ORDER BY "availableAt", "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SigningJob" j
       SET "status" = 'transition_running',
           "leaseOwner" = ${owner},
           "leaseUntil" = NOW() + INTERVAL '10 minutes',
           "attempts" = j."attempts" + 1,
           "updatedAt" = NOW()
      FROM candidates c
     WHERE j."id" = c."id"
    RETURNING j."id", j."tenantId", j."requestId", j."jobType", j."payload", j."attempts"
  `;
}

async function claimRequest(job: TransitionJob): Promise<string | null> {
  const owner = `transition-job:${job.id}:${crypto.randomUUID()}`;
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

async function releaseRequest(job: TransitionJob, owner: string): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "SignatureRequest"
       SET "recoveryLeaseOwner" = NULL, "recoveryLeaseUntil" = NULL
     WHERE "id" = ${job.requestId}
       AND "tenantId" = ${job.tenantId}
       AND "recoveryLeaseOwner" = ${owner}
  `.catch(() => 0);
}

async function execute(job: TransitionJob): Promise<void> {
  switch (job.jobType) {
    case "advance_signature":
      await advanceAfterSignature(job.requestId);
      return;

    case "decline_notify": {
      const recipientId = typeof job.payload.recipientId === "string" ? job.payload.recipientId : null;
      if (!recipientId) throw new Error("Decline transition has no recipientId");
      const rows = await basePrisma.$queryRaw<Array<{ name: string; declineReason: string | null }>>`
        SELECT "name", "declineReason" FROM "SignatureRecipient"
        WHERE "id" = ${recipientId}
          AND "requestId" = ${job.requestId}
          AND "tenantId" = ${job.tenantId}
          AND "status" = 'declined'
        LIMIT 1
      `;
      if (!rows[0]) return;
      const result = await notifyCreatorDeclined(job.requestId, rows[0].name, rows[0].declineReason ?? "");
      if (!result.ok) throw new Error(result.error || "Decline notification failed");
      return;
    }

    case "advance_approval": {
      await advanceWorkflow(job.requestId);
      const rows = await basePrisma.$queryRaw<Array<{ status: string }>>`
        SELECT "status" FROM "SignatureRequest"
        WHERE "id" = ${job.requestId} AND "tenantId" = ${job.tenantId}
        LIMIT 1
      `;
      if (rows[0]?.status === "rejected") {
        const result = await notifyCreatorRejected(job.requestId);
        if (!result.ok) throw new Error(result.error || "Rejection notification failed");
      }
      return;
    }

    default:
      throw new Error(`Unknown signing transition job: ${String(job.jobType)}`);
  }
}

async function complete(job: TransitionJob): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "SigningJob"
       SET "status" = 'completed', "completedAt" = NOW(), "leaseUntil" = NULL,
           "leaseOwner" = NULL, "lastError" = NULL, "updatedAt" = NOW()
     WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
  `;
}

async function retry(job: TransitionJob, error: unknown): Promise<"retry" | "dead"> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  const dead = job.attempts >= MAX_ATTEMPTS;
  const delayMinutes = Math.min(360, 2 ** Math.min(job.attempts, 8));
  const availableAt = new Date(Date.now() + delayMinutes * 60_000);
  await basePrisma.$executeRaw`
    UPDATE "SigningJob"
       SET "status" = ${dead ? "dead" : "transition_retry"},
           "availableAt" = ${availableAt}, "leaseUntil" = NULL,
           "leaseOwner" = NULL, "lastError" = ${message}, "updatedAt" = NOW()
     WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
  `;
  await logError(
    dead ? "signing-transition-dead" : "signing-transition-retry",
    new Error(message),
    `job ${job.id}, request ${job.requestId}`,
  ).catch(() => {});
  return dead ? "dead" : "retry";
}

export async function runSigningTransitionJobs(tenantId: string, limit = 20): Promise<TransitionJobRun> {
  if (!tenantId) throw new Error("Signing transition jobs require a concrete tenant id");
  return runInTenantScope({ tenantId, system: false }, async () => {
    const jobs = await claimJobs(tenantId, Math.max(1, Math.min(limit, 50)));
    const result: TransitionJobRun = { claimed: jobs.length, completed: 0, retried: 0, dead: 0, leased: 0 };

    for (const job of jobs) {
      const owner = await claimRequest(job);
      if (!owner) {
        result.leased += 1;
        await basePrisma.$executeRaw`
          UPDATE "SigningJob"
          SET "status" = 'transition_retry', "availableAt" = NOW() + INTERVAL '1 minute',
              "leaseUntil" = NULL, "leaseOwner" = NULL, "updatedAt" = NOW()
          WHERE "id" = ${job.id} AND "tenantId" = ${job.tenantId}
        `;
        continue;
      }
      try {
        await execute(job);
        await complete(job);
        result.completed += 1;
      } catch (error) {
        const state = await retry(job, error);
        result[state === "dead" ? "dead" : "retried"] += 1;
      } finally {
        await releaseRequest(job, owner);
      }
    }

    return result;
  });
}
