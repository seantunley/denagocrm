import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { runInTenantScope } from "@/lib/tenantScope";
import { assertOwnedBlob, readFile, deleteVerifiedOrphan } from "@/lib/storage";
import { logSignEvent } from "./events";

async function verifyRef(ref: string, expectedHash?: string | null): Promise<{ ok: boolean; size: number; hash: string; error?: string }> {
  try {
    let size = 0;
    try { size = (await assertOwnedBlob(ref)).size; }
    catch { /* local/non-Blob development ref */ }
    const bytes = await readFile(ref);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    return expectedHash && expectedHash !== hash
      ? { ok: false, size: bytes.length || size, hash, error: "SHA-256 mismatch" }
      : { ok: true, size: bytes.length || size, hash };
  } catch (error) {
    return { ok: false, size: 0, hash: "", error: error instanceof Error ? error.message : String(error) };
  }
}

export async function reconcileEnvelope(envelopeId: string): Promise<{ ok: boolean; errors: string[] }> {
  const rows = await basePrisma.$queryRaw<Array<{
    id: string; tenantId: string; status: string; unsignedPdfRef: string | null; signedPdfRef: string | null;
    signedPdfHash: string | null; signedDocId: string | null; legalRef: string | null; legalHash: string | null;
  }>>(Prisma.sql`
    SELECT q.id,q."tenantId",q.status,q."unsignedPdfRef",q."signedPdfRef",q."signedPdfHash",q."signedDocId",
           l."objectRef" AS "legalRef",l.sha256 AS "legalHash"
      FROM "SignatureRequest" q LEFT JOIN "LegalArtifact" l ON l."envelopeId"=q.id AND l."destroyedAt" IS NULL
     WHERE q.id=${envelopeId} LIMIT 1
  `);
  const request = rows[0];
  if (!request) return { ok: false, errors: ["Envelope not found"] };
  const errors: string[] = [];
  const refs = [
    { label: "unsigned", ref: request.unsignedPdfRef, hash: null },
    { label: "signed", ref: request.signedPdfRef, hash: request.signedPdfHash },
    { label: "legal", ref: request.legalRef, hash: request.legalHash },
  ];
  for (const item of refs) {
    if (!item.ref) {
      if (item.label !== "unsigned" && ["sealed", "distributing", "completed"].includes(request.status)) errors.push(`Missing ${item.label} artifact reference`);
      continue;
    }
    const result = await verifyRef(item.ref, item.hash);
    await basePrisma.$executeRaw`
      UPDATE "SigningArtifact" SET "lastVerifiedAt"=now(),"lastError"=${result.ok ? null : result.error ?? "verification failed"},
        sha256=COALESCE(sha256,${result.hash || null}),"sizeBytes"=COALESCE("sizeBytes",${result.size || null})
       WHERE "tenantId"=${request.tenantId} AND "objectRef"=${item.ref}
    `;
    if (!result.ok) errors.push(`${item.label}: ${result.error}`);
  }
  if (["sealed", "distributing", "completed"].includes(request.status) && !request.signedDocId) errors.push("Completed envelope has no filed Document row");
  const ok = errors.length === 0;
  if (!ok) {
    await basePrisma.$executeRaw`
      UPDATE "SignatureRequest" SET "failureCode"='artifact_integrity_failure',"failedAt"=now()
       WHERE id=${envelopeId} AND status IN ('sealed','distributing','completed')
    `;
  }
  await runInTenantScope({ tenantId: request.tenantId, system: false }, () =>
    logSignEvent(envelopeId, { type: "artifact_reconciled", actor: "system", metadata: { ok, errors } }),
  );
  return { ok, errors };
}

export async function reconcileCompletedEnvelopes(limit = 100): Promise<{ checked: number; failed: number }> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT q.id FROM "SignatureRequest" q
    LEFT JOIN "SigningArtifact" a ON a."envelopeId"=q.id AND a.kind='signed_pdf'
    WHERE q.status='completed' AND (a."lastVerifiedAt" IS NULL OR a."lastVerifiedAt" < now() - interval '24 hours')
    ORDER BY q."completedAt" DESC NULLS LAST LIMIT ${Math.max(1, Math.min(limit, 500))}
  `);
  let failed = 0;
  for (const row of rows) if (!(await reconcileEnvelope(row.id)).ok) failed += 1;
  return { checked: rows.length, failed };
}

export async function collectSettledOrphans(limit = 100): Promise<{ checked: number; deleted: number; retained: number }> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string; objectRef: string }>>(Prisma.sql`
    SELECT id,"objectRef" FROM "SigningArtifact"
     WHERE state IN ('uploaded','orphan_candidate') AND "settlementNotBefore" < now()
     ORDER BY "settlementNotBefore" LIMIT ${Math.max(1, Math.min(limit, 500))}
  `);
  let deleted = 0; let retained = 0;
  for (const row of rows) {
    try {
      await deleteVerifiedOrphan(row.objectRef);
      await basePrisma.$executeRaw`UPDATE "SigningArtifact" SET state='destroyed',"lastVerifiedAt"=now() WHERE id=${row.id}`;
      deleted += 1;
    } catch {
      await basePrisma.$executeRaw`UPDATE "SigningArtifact" SET state='retained',"lastVerifiedAt"=now() WHERE id=${row.id}`;
      retained += 1;
    }
  }
  return { checked: rows.length, deleted, retained };
}

export async function collectUnregisteredUploadIntents(limit = 100): Promise<{ checked: number; deleted: number; retained: number }> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string; objectRef: string }>>(Prisma.sql`
    SELECT id,"objectRef" FROM "SigningUploadIntent"
     WHERE status='uploaded' AND "objectRef" IS NOT NULL AND "uploadedAt" < now()-interval '24 hours'
     ORDER BY "uploadedAt" LIMIT ${Math.max(1, Math.min(limit, 500))}
  `);
  let deleted = 0; let retained = 0;
  for (const row of rows) {
    try {
      await deleteVerifiedOrphan(row.objectRef);
      await basePrisma.$executeRaw`UPDATE "SigningUploadIntent" SET status='settled',"settledAt"=now() WHERE id=${row.id}`;
      deleted += 1;
    } catch {
      await basePrisma.$executeRaw`UPDATE "SigningUploadIntent" SET status='retained',"settledAt"=now() WHERE id=${row.id}`;
      retained += 1;
    }
  }
  return { checked: rows.length, deleted, retained };
}
