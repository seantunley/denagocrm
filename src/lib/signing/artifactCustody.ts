import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { currentTenantScope } from "@/lib/tenantScope";

export type ArtifactKind = "unsigned_pdf" | "signed_pdf" | "signature_image" | "evidence_bundle" | "timestamp_token" | "validation_report";
export type ArtifactState = "uploaded" | "referenced" | "sealed" | "retained" | "orphan_candidate" | "destroyed";


export async function beginUploadIntent(input: { tenantId: string; plannedObjectKey: string; originalName: string; mimeType: string }): Promise<string | null> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "SigningUploadIntent"("tenantId","plannedObjectKey","originalName","mimeType")
      VALUES (${input.tenantId},${input.plannedObjectKey},${input.originalName},${input.mimeType})
      ON CONFLICT ("tenantId","plannedObjectKey") DO UPDATE SET
        status='uploading',"lastError"=NULL,"objectRef"=NULL,"uploadedAt"=NULL,"registeredAt"=NULL,"settledAt"=NULL
      RETURNING id
    `);
    return rows[0]?.id ?? null;
  } catch (error) {
    console.error("[signing-custody] upload-intent creation failed; write will remain retain-only", { input, error });
    return null;
  }
}

export async function completeUploadIntent(input: { id: string | null; objectRef: string; bytes: Buffer }): Promise<void> {
  if (!input.id) return;
  try {
    await basePrisma.$executeRaw`
      UPDATE "SigningUploadIntent" SET "objectRef"=${input.objectRef},sha256=${crypto.createHash("sha256").update(input.bytes).digest("hex")},
        "sizeBytes"=${input.bytes.length},status='uploaded',"uploadedAt"=now(),"lastError"=NULL WHERE id=${input.id}
    `;
  } catch (error) {
    console.error("[signing-custody] upload-intent completion failed; retaining uploaded object", { id: input.id, objectRef: input.objectRef, error });
  }
}

export async function failUploadIntent(id: string | null, error: unknown): Promise<void> {
  if (!id) return;
  await basePrisma.$executeRaw`
    UPDATE "SigningUploadIntent" SET status='failed',"lastError"=${error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000)}
     WHERE id=${id}
  `.catch(() => {});
}

export async function registerArtifactUpload(input: {
  tenantId: string;
  envelopeId?: string | null;
  kind: ArtifactKind;
  objectRef: string;
  bytes?: Buffer | null;
  sha256?: string | null;
  sizeBytes?: number | null;
}, tx?: Prisma.TransactionClient): Promise<void> {
  const db = tx ?? (basePrisma as unknown as Prisma.TransactionClient);
  const digest = input.sha256 ?? (input.bytes ? crypto.createHash("sha256").update(input.bytes).digest("hex") : null);
  const size = input.sizeBytes ?? input.bytes?.length ?? null;
  await db.$executeRaw`
    INSERT INTO "SigningArtifact"("tenantId","envelopeId",kind,"objectRef",sha256,"sizeBytes",state,"settlementNotBefore")
    VALUES (${input.tenantId}, ${input.envelopeId ?? null}, ${input.kind}, ${input.objectRef}, ${digest}, ${size}, 'uploaded', now() + interval '24 hours')
    ON CONFLICT ("tenantId","objectRef",kind) DO UPDATE SET
      "envelopeId" = COALESCE(EXCLUDED."envelopeId", "SigningArtifact"."envelopeId"),
      sha256 = COALESCE(EXCLUDED.sha256, "SigningArtifact".sha256),
      "sizeBytes" = COALESCE(EXCLUDED."sizeBytes", "SigningArtifact"."sizeBytes")
  `;
  await db.$executeRaw`
    UPDATE "SigningUploadIntent" SET status='registered',"registeredAt"=now(),"envelopeId"=COALESCE(${input.envelopeId ?? null},"envelopeId")
     WHERE "tenantId"=${input.tenantId} AND "objectRef"=${input.objectRef} AND status IN ('uploaded','uploading')
  `;
}

export async function markArtifactState(input: {
  tenantId: string;
  objectRef: string;
  kind?: ArtifactKind;
  envelopeId?: string | null;
  state: ArtifactState;
  error?: string | null;
}, tx?: Prisma.TransactionClient): Promise<void> {
  const db = tx ?? (basePrisma as unknown as Prisma.TransactionClient);
  await db.$executeRaw`
    UPDATE "SigningArtifact"
       SET state = ${input.state},
           "envelopeId" = COALESCE(${input.envelopeId ?? null}, "envelopeId"),
           "referencedAt" = CASE WHEN ${input.state} IN ('referenced','sealed','retained') THEN COALESCE("referencedAt", now()) ELSE "referencedAt" END,
           "sealedAt" = CASE WHEN ${input.state} = 'sealed' THEN COALESCE("sealedAt", now()) ELSE "sealedAt" END,
           "lastError" = ${input.error ?? null}
     WHERE "tenantId" = ${input.tenantId}
       AND "objectRef" = ${input.objectRef}
       AND (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
  `;
}

/**
 * Authoritative retain/delete decision. Any malformed result or database error
 * is retain-not-delete. A tenant scope is used when present; no scope means a
 * conservative cross-tenant check for platform maintenance.
 */
export async function isStorageRefReferenced(ref: string, tenantId = currentTenantScope()?.tenantId ?? null): Promise<boolean> {
  try {
    const tenant = tenantId;
    const [request, document, recipient, field, artifact, legal] = await Promise.all([
      basePrisma.signatureRequest.findFirst({
        where: {
          ...(tenant ? { tenantId: tenant } : {}),
          OR: [{ unsignedPdfRef: ref }, { signedPdfRef: ref }],
        },
        select: { id: true },
      }),
      basePrisma.document.findFirst({ where: { ...(tenant ? { tenantId: tenant } : {}), storedName: ref }, select: { id: true } }),
      basePrisma.signatureRecipient.findFirst({ where: { ...(tenant ? { tenantId: tenant } : {}), signatureRef: ref }, select: { id: true } }),
      basePrisma.signatureField.findFirst({ where: { ...(tenant ? { tenantId: tenant } : {}), value: ref }, select: { id: true } }),
      basePrisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
        SELECT EXISTS(
          SELECT 1 FROM "SigningArtifact"
           WHERE "objectRef" = ${ref}
             AND (${tenant}::text IS NULL OR "tenantId" = ${tenant})
             AND state IN ('referenced','sealed','retained')
        ) AS exists
      `),
      basePrisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
        SELECT EXISTS(
          SELECT 1 FROM "LegalArtifact"
           WHERE ("objectRef" = ${ref} OR "timestampTokenRef" = ${ref})
             AND (${tenant}::text IS NULL OR "tenantId" = ${tenant})
             AND "destroyedAt" IS NULL
        ) AS exists
      `),
    ]);
    return Boolean(request || document || recipient || field || artifact[0]?.exists || legal[0]?.exists);
  } catch (error) {
    console.error("[signing-custody] reference verification failed; retaining object", { ref, error });
    return true;
  }
}

export async function recordLegalArtifact(input: {
  tenantId: string;
  envelopeId: string;
  documentId: string | null;
  objectRef: string;
  sha256: string;
  sizeBytes: number;
  certificateFingerprint: string;
  certificateChain: unknown;
  keyId: string | null;
  trustPolicy: string;
  timestampTokenRef: string | null;
  validationReport: unknown;
  retentionClass?: string;
  retainUntil?: Date;
}, tx: Prisma.TransactionClient): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "LegalArtifact"(
      "tenantId","envelopeId","documentId","objectRef",sha256,"sizeBytes",
      "certificateFingerprint","certificateChainJson","keyId","trustPolicy",
      "timestampTokenRef","validationReportJson","retentionClass","retainUntil"
    ) VALUES (
      ${input.tenantId}, ${input.envelopeId}, ${input.documentId}, ${input.objectRef}, ${input.sha256}, ${input.sizeBytes},
      ${input.certificateFingerprint}, ${JSON.stringify(input.certificateChain)}::jsonb, ${input.keyId}, ${input.trustPolicy},
      ${input.timestampTokenRef}, ${JSON.stringify(input.validationReport)}::jsonb,
      ${input.retentionClass ?? "contract-7y"}, ${input.retainUntil ?? new Date(Date.now() + 7 * 365.25 * 24 * 60 * 60 * 1000)}
    )
    ON CONFLICT ("tenantId","envelopeId","artifactVersion") DO UPDATE SET "envelopeId" = EXCLUDED."envelopeId"
    RETURNING id
  `);
  return rows[0]!.id;
}


/**
 * Register an apparently unreferenced upload for delayed settlement. This is the
 * only normal compensation path after an upload: commit uncertainty never causes
 * synchronous byte deletion. A database failure retains the object.
 */
export async function scheduleOrphanSettlement(ref: string, tenantId: string): Promise<void> {
  try {
    await basePrisma.$transaction(async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE "SigningArtifact" SET state='orphan_candidate',"settlementNotBefore"=GREATEST("settlementNotBefore",now()+interval '24 hours'),
          "lastError"='awaiting authoritative orphan settlement'
         WHERE "tenantId"=${tenantId} AND "objectRef"=${ref} AND state='uploaded'
      `;
      if (updated === 0) {
        await tx.$executeRaw`
          INSERT INTO "SigningArtifact"("tenantId",kind,"objectRef",state,"settlementNotBefore","lastError")
          VALUES (${tenantId},'unclassified_orphan',${ref},'orphan_candidate',now()+interval '24 hours','awaiting authoritative orphan settlement')
          ON CONFLICT ("tenantId","objectRef",kind) DO UPDATE SET
            state=CASE WHEN "SigningArtifact".state IN ('referenced','sealed','retained') THEN "SigningArtifact".state ELSE 'orphan_candidate' END,
            "settlementNotBefore"=GREATEST("SigningArtifact"."settlementNotBefore",now()+interval '24 hours')
        `;
      }
    });
  } catch (error) {
    console.error("[signing-custody] could not schedule orphan settlement; retaining object", { ref, tenantId, error });
  }
}

/**
 * The only reference-check bypass: an approved, dual-controlled legal-artifact
 * destruction request authorises deletion of the artifact bytes (and its trusted
 * timestamp token) after retention/hold checks have already passed.
 */
export async function isApprovedLegalDestruction(ref: string, requestId: string, tenantId: string): Promise<boolean> {
  try {
    const rows = await basePrisma.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`
      SELECT EXISTS(
        SELECT 1
          FROM "LegalArtifactDestructionRequest" r
          JOIN "LegalArtifact" a ON a.id=r."artifactId" AND a."tenantId"=r."tenantId"
         WHERE r.id=${requestId} AND r."tenantId"=${tenantId} AND r.status IN ('approved','executing')
           AND r."requestedById" <> r."approvedById"
           AND a."legalHold"=false AND a."retainUntil" <= now() AND a."destroyedAt" IS NULL
           AND (a."objectRef"=${ref} OR a."timestampTokenRef"=${ref})
      ) AS allowed
    `);
    return rows[0]?.allowed === true;
  } catch (error) {
    console.error("[signing-custody] destruction authorisation lookup failed", { requestId, ref, error });
    return false;
  }
}
