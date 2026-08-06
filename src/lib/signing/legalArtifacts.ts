import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { deleteApprovedLegalObject } from "@/lib/storage";

export async function requestArtifactDestruction(input: {
  artifactId: string; tenantId: string; requestedById: string; reason: string;
}): Promise<string> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "LegalArtifactDestructionRequest"("tenantId","artifactId",reason,"requestedById")
    SELECT ${input.tenantId},id,${input.reason.trim().slice(0, 1000)},${input.requestedById}
      FROM "LegalArtifact"
     WHERE id=${input.artifactId} AND "tenantId"=${input.tenantId} AND "legalHold"=false
       AND "retainUntil" <= now() AND "destroyedAt" IS NULL
    RETURNING id
  `);
  if (!rows[0]) throw new Error("Artifact is retained, on legal hold, already destroyed or cross-tenant");
  return rows[0].id;
}

export async function approveArtifactDestruction(input: {
  requestId: string; tenantId: string; approvedById: string;
}): Promise<void> {
  const updated = await basePrisma.$executeRaw`
    UPDATE "LegalArtifactDestructionRequest" SET status='approved',"approvedById"=${input.approvedById},"approvedAt"=now()
     WHERE id=${input.requestId} AND "tenantId"=${input.tenantId} AND status='pending'
       AND "requestedById" <> ${input.approvedById}
  `;
  if (updated !== 1) throw new Error("Destruction requires an independent second approver");
}

export async function executeArtifactDestruction(input: {
  requestId: string; tenantId: string; executedById: string;
}): Promise<Record<string, unknown>> {
  const rows = await basePrisma.$transaction((tx) => tx.$queryRaw<Array<{
    artifactId: string; objectRef: string; timestampTokenRef: string | null; sha256: string; envelopeId: string; requestedById: string; approvedById: string;
  }>>(Prisma.sql`
    UPDATE "LegalArtifactDestructionRequest" r SET status='executing'
      FROM "LegalArtifact" a
     WHERE r.id=${input.requestId} AND r."tenantId"=${input.tenantId} AND r.status='approved'
       AND a.id=r."artifactId" AND a."tenantId"=r."tenantId"
       AND a."legalHold"=false AND a."retainUntil" <= now() AND a."destroyedAt" IS NULL
    RETURNING r."artifactId",a."objectRef",a."timestampTokenRef",a.sha256,a."envelopeId",r."requestedById",r."approvedById"
  `));
  const row = rows[0];
  if (!row) throw new Error("Approved artifact destruction is not executable");
  try {
    await deleteApprovedLegalObject(row.objectRef, input.requestId, input.tenantId);
    if (row.timestampTokenRef) await deleteApprovedLegalObject(row.timestampTokenRef, input.requestId, input.tenantId);
  } catch (error) {
    await basePrisma.$executeRaw`UPDATE "LegalArtifactDestructionRequest" SET status='approved' WHERE id=${input.requestId} AND status='executing'`;
    throw error;
  }
  const certificate = {
    format: "denago-legal-artifact-destruction/v1",
    artifactId: row.artifactId,
    envelopeId: row.envelopeId,
    destroyedObjectRefHash: crypto.createHash("sha256").update(row.objectRef).digest("hex"),
    timestampTokenRefHash: row.timestampTokenRef ? crypto.createHash("sha256").update(row.timestampTokenRef).digest("hex") : null,
    artifactSha256: row.sha256,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    executedById: input.executedById,
    executedAt: new Date().toISOString(),
  };
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "LegalArtifact" SET "destroyedAt"=now(),"destroyedById"=${input.executedById},
        "destructionCertificateJson"=${JSON.stringify(certificate)}::jsonb WHERE id=${row.artifactId} AND "destroyedAt" IS NULL
    `;
    await tx.$executeRaw`
      UPDATE "SigningArtifact" SET state='destroyed',"lastVerifiedAt"=now() WHERE "tenantId"=${input.tenantId}
        AND "objectRef" IN (${row.objectRef},${row.timestampTokenRef ?? row.objectRef})
    `;
    await tx.$executeRaw`
      UPDATE "LegalArtifactDestructionRequest" SET status='executed',"executedById"=${input.executedById},
        "executedAt"=now(),"certificateJson"=${JSON.stringify(certificate)}::jsonb WHERE id=${input.requestId} AND status='executing'
    `;
  });
  return certificate;
}
