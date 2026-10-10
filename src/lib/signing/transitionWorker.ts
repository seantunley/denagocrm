import "server-only";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { runInTenantScope } from "@/lib/tenantScope";
import { advanceAfterSignature } from "./workflow";
import { advanceWorkflow } from "@/lib/signflow/runtime";
import { notifyApprover } from "./approvals";
import { notifyCreatorDeclined, notifyCreatorRejected } from "./notify";

const MAX_ATTEMPTS = 12;

type TransitionJob = {
  id: string;
  tenantId: string;
  requestId: string;
  jobType: "advance_signature" | "decline_notify" | "advance_approval" | "approval_notify";
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

/**
 * `transition_running` is claimable too — once its lease has run out.
 *
 * A job is left in that state when the worker running it dies: the function hit
 * its time limit halfway through rendering a PDF, or the process was recycled.
 * Nothing then moved it on. The lease test below was written for exactly that,
 * but the status list excluded the only state a lease is ever held in, so the
 * job sat there for good — a document everyone had signed, never finished, never
 * retried and never reported. A live run still holds an unexpired lease and is
 * left alone.
 */
async function claimJobs(tenantId: string, limit: number, requestId: string | null): Promise<TransitionJob[]> {
  const owner = `transition:${crypto.randomUUID()}`;
  return basePrisma.$queryRaw<TransitionJob[]>`
    WITH candidates AS (
      SELECT "id" FROM "SigningJob"
      WHERE "tenantId" = ${tenantId}
        AND "status" IN ('transition','transition_retry','transition_running')
        AND "availableAt" <= NOW()
        AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW())
        AND (${requestId}::text IS NULL OR "requestId" = ${requestId})
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

    case "approval_notify": {
      const stepId = typeof job.payload.approvalStepId === "string" ? job.payload.approvalStepId : null;
      if (!stepId) throw new Error("Approval-delivery job has no approvalStepId");
      const result = await notifyApprover(stepId);
      if (!result.ok) throw new Error(result.error || "Approval-link delivery failed");
      return;
    }

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

/**
 * How many times one run goes back to the queue.
 *
 * A job can queue the next one: an approval that is granted raises the following
 * approval, and telling that approver is itself a job. A single pass left it for
 * the next scheduled run — half an hour for an email that was ready to go — so
 * the queue is asked again until a pass finds nothing new. It cannot spin: a job
 * that failed or was leased is pushed into the future and is not claimable again
 * in the same run.
 */
const MAX_PASSES = 4;

/**
 * `only.requestId` confines a run to one request's jobs. That is what a web
 * request uses to deliver what it has just queued (deliverQueuedNow in
 * signflow/runtime.ts) without taking on the whole workspace's backlog — a PDF
 * render for somebody else's document — inside its own time limit.
 */
export async function runSigningTransitionJobs(
  tenantId: string,
  limit = 20,
  only: { requestId?: string } = {},
): Promise<TransitionJobRun> {
  if (!tenantId) throw new Error("Signing transition jobs require a concrete tenant id");
  return runInTenantScope({ tenantId, system: false }, async () => {
    const result: TransitionJobRun = { claimed: 0, completed: 0, retried: 0, dead: 0, leased: 0 };

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const jobs = await claimJobs(tenantId, Math.max(1, Math.min(limit, 50)), only.requestId ?? null);
      if (jobs.length === 0) break;
      result.claimed += jobs.length;

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
    }

    return result;
  });
}
