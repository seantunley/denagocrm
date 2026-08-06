import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { anchorEvidence } from "./evidenceBundle";

/**
 * Finalize an envelope only after every durable distribution/reconciliation job
 * has succeeded. The completed event is appended before the external evidence
 * anchor so the anchor covers the final state and no later evidence event is
 * written by this operation.
 */
export async function finalizeSigningCompletion(envelopeId: string, finalizerJobId: string): Promise<void> {
  const rows = await basePrisma.$queryRaw<Array<{ tenantId: string; status: string; signedPdfHash: string | null }>>(Prisma.sql`
    SELECT "tenantId",status,"signedPdfHash" FROM "SignatureRequest" WHERE id=${envelopeId} LIMIT 1
  `);
  const request = rows[0];
  if (!request) throw new Error("Envelope not found");
  if (request.status === "completed") return;
  if (request.status === "failed_manual_intervention") throw new Error("Envelope requires manual intervention");
  if (!["sealed", "distributing"].includes(request.status)) {
    throw new Error(`Envelope is not ready to finalize (${request.status})`);
  }

  const jobs = await basePrisma.$queryRaw<Array<{ status: string; jobType: string; lastError: string | null }>>(Prisma.sql`
    SELECT status,"jobType","lastError" FROM "SigningOutboxJob"
     WHERE "envelopeId"=${envelopeId} AND id<>${finalizerJobId}
       AND "jobType" NOT IN ('finalize_completion','anchor_evidence')
  `);
  const dead = jobs.filter((job) => job.status === "dead_letter");
  if (dead.length) {
    const reason = dead.map((job) => `${job.jobType}: ${job.lastError || "dead letter"}`).join("; ").slice(0, 1000);
    await basePrisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "SignatureRequest" SET status='failed_manual_intervention',"failedAt"=now(),
          "failureCode"=${`distribution_failed:${reason}`},"stateVersion"="stateVersion"+1
         WHERE id=${envelopeId} AND status IN ('sealed','distributing')
      `;
      await tx.$executeRaw`
        INSERT INTO "SignatureEvent"(id,"tenantId","requestId",type,actor,channel,metadata,"createdAt")
        SELECT gen_random_uuid()::text,${request.tenantId},${envelopeId},'manual_intervention_required','system','worker',
          ${JSON.stringify({ reason: "durable_completion_job_dead_letter", detail: reason })}::jsonb,now()
        WHERE NOT EXISTS (
          SELECT 1 FROM "SignatureEvent" WHERE "requestId"=${envelopeId}
            AND type='manual_intervention_required' AND metadata->>'reason'='durable_completion_job_dead_letter'
        )
      `;
    });
    throw new Error(reason);
  }
  if (jobs.some((job) => !["completed", "cancelled"].includes(job.status))) {
    throw new Error("Completion dependencies are still pending");
  }

  // Idempotent final evidence event. The DB trigger serializes and hashes it.
  await basePrisma.$executeRaw`
    INSERT INTO "SignatureEvent"(id,"tenantId","requestId",type,actor,channel,metadata,"createdAt")
    SELECT gen_random_uuid()::text,${request.tenantId},${envelopeId},'completed','system','worker',
      ${JSON.stringify({ finalizedBy: "transactional_outbox", signedPdfHash: request.signedPdfHash })}::jsonb,now()
    WHERE NOT EXISTS (
      SELECT 1 FROM "SignatureEvent" WHERE "requestId"=${envelopeId}
        AND type='completed' AND metadata->>'finalizedBy'='transactional_outbox'
    )
  `;

  // Must succeed before the public state can say complete.
  await anchorEvidence(envelopeId);

  const updated = await basePrisma.$executeRaw`
    UPDATE "SignatureRequest" SET status='completed',"completedAt"=COALESCE("completedAt",now()),"failureCode"=NULL,"stateVersion"="stateVersion"+1
     WHERE id=${envelopeId} AND status IN ('sealed','distributing')
  `;
  if (updated !== 1) {
    const current = await basePrisma.signatureRequest.findUnique({ where: { id: envelopeId }, select: { status: true } });
    if (current?.status !== "completed") throw new Error("Completion finalization lost its state claim");
  }
}
