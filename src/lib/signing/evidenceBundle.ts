import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { isProductionRuntime } from "./securityConfig";

function hash(value: Buffer | string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, nested) => typeof nested === "bigint" ? nested.toString() : nested)) as T;
}

export async function buildPortableEvidenceBundle(envelopeId: string): Promise<Record<string, unknown>> {
  const requests = await basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT q.id,q."tenantId",q.title,q.status,q.ordering,q."documentId",q."quoteId",q."jobCardId",q."contactId",q."templateId",
      q."snapshotJson",q."canonicalSourceHash",q."workflowHash",q."releaseId",q."consentVersion",q."identityPolicy",q."assuranceLevel",
      q."signedPdfHash",q."sentAt",q."completedAt",q."createdAt",q."updatedAt",
      l.id AS "legalArtifactId",l."artifactVersion",l."objectRef",l.sha256 AS "legalSha256",
      l."sizeBytes" AS "legalSizeBytes",l."certificateFingerprint",l."certificateChainJson",l."keyId",
      l."trustPolicy",l."timestampTokenRef",l."validationReportJson",l."retentionClass",l."retainUntil",l."legalHold"
    FROM "SignatureRequest" q LEFT JOIN "LegalArtifact" l ON l."envelopeId"=q.id AND l."destroyedAt" IS NULL
    WHERE q.id=${envelopeId} LIMIT 1
  `);
  const request = requests[0] as Record<string, unknown> | undefined;
  if (!request) throw new Error("Envelope not found");
  const [recipients, fields, responses, events, deliveries, anchors, recoveries, artifactRows] = await Promise.all([
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT id,name,email,phone,role,"order",status,"signedAt","signedName","viewedAt","signerIp","signerUserAgent","authMethod","assuranceLevel","authVerifiedAt","authTransactionId" FROM "SignatureRecipient" WHERE "requestId"=${envelopeId} ORDER BY "order",id`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT id,"recipientId",kind,page,x,y,width,height,required,label,"filledAt" FROM "SignatureField" WHERE "requestId"=${envelopeId} ORDER BY page,y,x,id`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT r."fieldId",r."recipientId",r.value,r."filledAt" FROM "SignatureFieldResponse" r JOIN "SignatureField" f ON f.id=r."fieldId" WHERE f."requestId"=${envelopeId} ORDER BY r."filledAt",r.id`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT sequence,type,actor,channel,ip,"userAgent",metadata,"createdAt","prevHash","payloadHash","eventHash",producer,"releaseId","schemaVersion" FROM "SignatureEvent" WHERE "requestId"=${envelopeId} ORDER BY sequence`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT "recipientId",channel,purpose,status,attempts,"providerMessageId","lastError","queuedAt","sentAt","deliveredAt" FROM "SigningDelivery" WHERE "envelopeId"=${envelopeId} ORDER BY "queuedAt"`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT sequence,"eventHash","rootHash",provider,"anchorRef","anchoredAt" FROM "SigningEvidenceAnchor" WHERE "envelopeId"=${envelopeId} ORDER BY "anchoredAt"`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT reason,action,"operatorId","beforeJson","afterJson","createdAt" FROM "SigningRecoveryAction" WHERE "envelopeId"=${envelopeId} ORDER BY "createdAt"`),
    basePrisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`SELECT kind,sha256,"sizeBytes",state,"referencedAt","sealedAt","lastVerifiedAt" FROM "SigningArtifact" WHERE "envelopeId"=${envelopeId} ORDER BY kind,id`),
  ]);
  const objectRef = request.objectRef as string | undefined;
  if (!objectRef) throw new Error("Completed envelope has no immutable legal artifact");
  const timestampTokenRef = request.timestampTokenRef as string | null | undefined;
  const [pdf, timestampToken] = await Promise.all([
    readFile(objectRef),
    timestampTokenRef ? readFile(timestampTokenRef) : Promise.resolve(null),
  ]);
  const artifactManifest = [
    { name: "sealed-document.pdf", mimeType: "application/pdf", sha256: hash(pdf), sizeBytes: pdf.length },
    ...(timestampToken ? [{ name: "trusted-timestamp.tsr", mimeType: "application/timestamp-reply", sha256: hash(timestampToken), sizeBytes: timestampToken.length }] : []),
  ];
  const manifest = jsonSafe({
    format: "denago-signing-evidence-bundle/v1",
    generatedAt: new Date().toISOString(),
    envelope: request,
    recipients,
    fields,
    responses,
    events,
    deliveries,
    anchors,
    recoveries,
    artifactLedger: artifactRows,
    artifacts: artifactManifest,
  });
  const manifestJson = JSON.stringify(manifest);
  const pdfHash = hash(pdf);
  const timestampHash = timestampToken ? hash(timestampToken) : "";
  return {
    manifest,
    manifestSha256: hash(manifestJson),
    sealedPdfBase64: pdf.toString("base64"),
    trustedTimestampBase64: timestampToken?.toString("base64") ?? null,
    bundleRootSha256: hash(Buffer.concat([Buffer.from(manifestJson), Buffer.from(pdfHash), Buffer.from(timestampHash)])),
  };
}

export async function anchorEvidence(envelopeId: string): Promise<void> {
  const rows = await basePrisma.$queryRaw<Array<{ tenantId: string; sequence: bigint; eventHash: string }>>(Prisma.sql`
    SELECT q."tenantId",e.sequence,e."eventHash" FROM "SignatureRequest" q
    JOIN "SignatureEvent" e ON e."requestId"=q.id WHERE q.id=${envelopeId}
    ORDER BY e.sequence DESC LIMIT 1
  `);
  const latest = rows[0];
  if (!latest) throw new Error("No evidence event exists to anchor");
  const rootHash = hash(`${envelopeId}:${latest.sequence}:${latest.eventHash}`);
  let provider = "database-root";
  let anchorRef: string | null = null;
  if (isProductionRuntime() && (!process.env.SIGNING_ANCHOR_URL || !process.env.SIGNING_ANCHOR_TOKEN)) {
    throw new Error("Production evidence anchoring requires an external anchor service");
  }
  if (process.env.SIGNING_ANCHOR_URL && process.env.SIGNING_ANCHOR_TOKEN) {
    const response = await fetch(process.env.SIGNING_ANCHOR_URL, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${process.env.SIGNING_ANCHOR_TOKEN}` },
      body: JSON.stringify({ envelopeId, sequence: latest.sequence.toString(), eventHash: latest.eventHash, rootHash }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Evidence anchor service failed: ${response.status}`);
    const result = await response.json() as { provider?: string; anchorRef?: string };
    provider = result.provider || "external"; anchorRef = result.anchorRef || null;
  }
  await basePrisma.$executeRaw`
    INSERT INTO "SigningEvidenceAnchor"("tenantId","envelopeId",sequence,"eventHash","rootHash",provider,"anchorRef")
    VALUES (${latest.tenantId},${envelopeId},${latest.sequence},${latest.eventHash},${rootHash},${provider},${anchorRef})
    ON CONFLICT ("tenantId","envelopeId","rootHash") DO NOTHING
  `;
}
