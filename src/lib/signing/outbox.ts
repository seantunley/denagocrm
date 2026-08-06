import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";

export type SigningJobType =
  | "advance_after_signature"
  | "deliver_signing_link"
  | "deliver_completed"
  | "deliver_approval"
  | "post_complete"
  | "finalize_completion"
  | "anchor_evidence"
  | "reconcile_envelope";

export type SigningOutboxJob = {
  id: string;
  tenantId: string;
  envelopeId: string | null;
  recipientId: string | null;
  jobType: SigningJobType;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  status: string;
  attempts: number;
  availableAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
};

export async function enqueueSigningJob(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    envelopeId?: string | null;
    recipientId?: string | null;
    jobType: SigningJobType;
    payload?: Record<string, unknown>;
    idempotencyKey: string;
    availableAt?: Date;
  },
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "SigningOutboxJob"(
      "tenantId","envelopeId","recipientId","jobType",payload,"idempotencyKey","availableAt"
    ) VALUES (
      ${input.tenantId}, ${input.envelopeId ?? null}, ${input.recipientId ?? null}, ${input.jobType},
      ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.idempotencyKey}, ${input.availableAt ?? new Date()}
    ) ON CONFLICT ("idempotencyKey") DO NOTHING
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

export async function enqueueSigningJobNow(input: Parameters<typeof enqueueSigningJob>[1]): Promise<string | null> {
  return basePrisma.$transaction((tx) => enqueueSigningJob(tx, input));
}

export async function leaseSigningJobs(limit = 20, onlyIds?: string[]): Promise<SigningOutboxJob[]> {
  const worker = `${process.env.VERCEL_REGION || "local"}:${process.pid}:${crypto.randomUUID()}`;
  return basePrisma.$transaction(async (tx) => tx.$queryRaw<SigningOutboxJob[]>(Prisma.sql`
    WITH picked AS (
      SELECT id FROM "SigningOutboxJob"
       WHERE (
          status IN ('pending','retry')
          OR (status = 'leased' AND "leaseExpiresAt" < now())
       )
       AND "availableAt" <= now()
       AND (${onlyIds?.length ? Prisma.sql`id IN (${Prisma.join(onlyIds)})` : Prisma.sql`TRUE`})
       ORDER BY "availableAt", "createdAt"
       FOR UPDATE SKIP LOCKED
       LIMIT ${Math.max(1, Math.min(limit, 100))}
    )
    UPDATE "SigningOutboxJob" j
       SET status = 'leased', attempts = attempts + 1, "leaseOwner" = ${worker},
           "leaseExpiresAt" = now() + interval '5 minutes', "updatedAt" = now()
      FROM picked WHERE j.id = picked.id
    RETURNING j.*
  `));
}

export async function completeSigningJob(id: string): Promise<void> {
  await basePrisma.$executeRaw`
    UPDATE "SigningOutboxJob" SET status='completed', "completedAt"=now(),
      "leaseOwner"=NULL, "leaseExpiresAt"=NULL, "lastError"=NULL, "updatedAt"=now()
    WHERE id=${id} AND status='leased'
  `;
}

export async function failSigningJob(job: SigningOutboxJob, error: unknown): Promise<void> {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  const terminal = job.attempts >= Number(process.env.SIGNING_OUTBOX_MAX_ATTEMPTS || 12);
  const delaySeconds = Math.min(6 * 60 * 60, Math.max(30, 2 ** Math.min(job.attempts, 10) * 15));
  await basePrisma.$executeRaw`
    UPDATE "SigningOutboxJob"
       SET status=${terminal ? "dead_letter" : "retry"}, "lastError"=${message},
           "availableAt"=now() + (${delaySeconds}::text || ' seconds')::interval,
           "leaseOwner"=NULL, "leaseExpiresAt"=NULL, "updatedAt"=now()
     WHERE id=${job.id} AND status='leased'
  `;
}

export async function deadLetterCount(tenantId?: string): Promise<number> {
  const rows = await basePrisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS count FROM "SigningOutboxJob"
     WHERE status='dead_letter' AND (${tenantId ?? null}::text IS NULL OR "tenantId"=${tenantId ?? null})
  `);
  return Number(rows[0]?.count ?? 0n);
}
