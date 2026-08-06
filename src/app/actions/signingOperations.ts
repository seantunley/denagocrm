"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { enqueueSigningJob } from "@/lib/signing/outbox";
import { requestArtifactDestruction, approveArtifactDestruction, executeArtifactDestruction } from "@/lib/signing/legalArtifacts";

async function operator() {
  const user = await requirePermission("signing.manage");
  const row = await basePrisma.user.findUnique({ where: { id: user.id }, select: { tenantId: true } });
  if (!row?.tenantId) throw new Error("The operator is not assigned to a tenant");
  return { ...user, tenantId: row.tenantId };
}

async function recovery(tenantId: string, envelopeId: string, operatorId: string, reason: string, action: string, before?: unknown, after?: unknown) {
  await basePrisma.$executeRaw`
    INSERT INTO "SigningRecoveryAction"("tenantId","envelopeId",reason,action,"operatorId","beforeJson","afterJson")
    VALUES (${tenantId},${envelopeId},${reason},${action},${operatorId},${before == null ? null : JSON.stringify(before)}::jsonb,${after == null ? null : JSON.stringify(after)}::jsonb)
  `;
}

export async function retrySigningJob(formData: FormData): Promise<void> {
  const user = await operator();
  const jobId = String(formData.get("jobId") || "");
  const rows = await basePrisma.$queryRaw<Array<{ envelopeId: string | null; status: string; attempts: number; lastError: string | null }>>(Prisma.sql`
    UPDATE "SigningOutboxJob" SET status='pending',attempts=0,"availableAt"=now(),"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=now()
     WHERE id=${jobId} AND "tenantId"=${user.tenantId} AND status IN ('dead_letter','retry')
    RETURNING "envelopeId",status,attempts,"lastError"
  `);
  const job = rows[0];
  if (!job?.envelopeId) throw new Error("Job is not retryable");
  await recovery(user.tenantId, job.envelopeId, user.id, "Operator requeued failed durable job", "outbox_retry", job, { status: "pending", attempts: 0 });
  revalidatePath("/settings/signing");
}

export async function queueEnvelopeReconciliation(formData: FormData): Promise<void> {
  const user = await operator();
  const envelopeId = String(formData.get("envelopeId") || "");
  const owned = await basePrisma.signatureRequest.findFirst({ where: { id: envelopeId, tenantId: user.tenantId }, select: { id: true } });
  if (!owned) throw new Error("Envelope not found");
  await basePrisma.$transaction((tx) => enqueueSigningJob(tx, {
    tenantId: user.tenantId, envelopeId, jobType: "reconcile_envelope", payload: { operatorId: user.id },
    idempotencyKey: `manual-reconcile:${envelopeId}:${Date.now()}`,
  }));
  await recovery(user.tenantId, envelopeId, user.id, "Operator requested artifact integrity verification", "reconcile_queued");
  revalidatePath("/settings/signing");
}

export async function setLegalHold(formData: FormData): Promise<void> {
  const user = await operator();
  const artifactId = String(formData.get("artifactId") || "");
  const hold = String(formData.get("hold")) === "true";
  const rows = await basePrisma.$queryRaw<Array<{ envelopeId: string; legalHold: boolean }>>(Prisma.sql`
    UPDATE "LegalArtifact" SET "legalHold"=${hold}
     WHERE id=${artifactId} AND "tenantId"=${user.tenantId} AND "destroyedAt" IS NULL
    RETURNING "envelopeId","legalHold"
  `);
  const artifact = rows[0];
  if (!artifact) throw new Error("Legal artifact not found");
  await recovery(user.tenantId, artifact.envelopeId, user.id, hold ? "Legal hold placed" : "Legal hold released", hold ? "legal_hold_set" : "legal_hold_released", null, { artifactId, hold });
  revalidatePath("/settings/signing");
}

export async function requestLegalDestruction(formData: FormData): Promise<void> {
  const user = await operator();
  const artifactId = String(formData.get("artifactId") || "");
  const reason = String(formData.get("reason") || "");
  await requestArtifactDestruction({ artifactId, tenantId: user.tenantId, requestedById: user.id, reason });
  revalidatePath("/settings/signing");
}

export async function approveLegalDestruction(formData: FormData): Promise<void> {
  const user = await operator();
  await approveArtifactDestruction({ requestId: String(formData.get("requestId") || ""), tenantId: user.tenantId, approvedById: user.id });
  revalidatePath("/settings/signing");
}

export async function executeLegalDestruction(formData: FormData): Promise<void> {
  const user = await operator();
  await executeArtifactDestruction({ requestId: String(formData.get("requestId") || ""), tenantId: user.tenantId, executedById: user.id });
  revalidatePath("/settings/signing");
}
