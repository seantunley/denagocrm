import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml, type StampField } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import { sealPdfWithEvidence } from "@/lib/pdf/seal";
import { saveFile, readFile, deleteFile } from "@/lib/storage";
import { formatDateTime } from "@/lib/format";
import { resolveTenantActor } from "@/lib/tenantActor";
import { logoDataUri } from "./render";
import { isRequestClosed } from "./status";
import { registerArtifactUpload, markArtifactState, recordLegalArtifact } from "./artifactCustody";
import { signingReleaseId } from "./securityConfig";

class CompletionLost extends Error {}
class SourceCompletionLost extends Error {}
const esc = (value: unknown) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function sigImg(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  try { return `data:image/png;base64,${(await readFile(ref)).toString("base64")}`; }
  catch { return null; }
}

type RecipientEvidence = {
  id: string; name: string; email: string | null; phone: string | null; role: string;
  signedAt: Date | null; signerIp: string | null; userAgent: string | null; signatureRef: string | null;
  authMethod: string | null; assuranceLevel: string | null; authTransactionId: string | null;
};

function maskEmail(value: string | null): string {
  if (!value) return "—";
  const [local, domain] = value.split("@");
  return `${local?.slice(0, 2) || "*"}•••@${domain || ""}`;
}
function maskPhone(value: string | null): string { return value ? `••••${value.replace(/\D/g, "").slice(-4)}` : "—"; }

function certificateHtml(input: {
  title: string; requestId: string; tenantId: string; canonicalSourceHash: string | null;
  consentVersion: string; releaseId: string; rows: Array<RecipientEvidence & { image: string | null }>;
}): string {
  const signers = input.rows.map((row) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <div style="display:flex;justify-content:space-between"><strong>${esc(row.name)}</strong><span>${esc(row.role)}</span></div>
      ${row.image ? `<img src="${row.image}" style="height:56px;margin:8px 0"/>` : `<div style="color:#94a3b8;margin:8px 0">Accepted without a drawn signature</div>`}
      <div style="font-size:8.5pt;color:#64748b">Signed ${row.signedAt ? esc(formatDateTime(row.signedAt)) : "—"} · IP ${esc(row.signerIp || "—")}</div>
      <div style="font-size:8.5pt;color:#64748b">Identity ${esc(row.authMethod || "link")} · ${esc(row.assuranceLevel || "ES-1")} · ${esc(row.authTransactionId || "—")}</div>
      <div style="font-size:8.5pt;color:#64748b">Recipient ${esc(maskEmail(row.email))} · ${esc(maskPhone(row.phone))}</div>
    </div>`).join("");
  return `<div style="page-break-before:always;padding-top:6px">
    <h1 style="font-size:18pt;color:#020617;margin:0 0 4px">Certificate of Completion</h1>
    <p style="color:#64748b;font-size:10pt">Audit record for “${esc(input.title)}” · envelope ${esc(input.requestId)}</p>
    ${signers}
    <div style="margin-top:14px;background:#f8fafc;border-left:3px solid #ea580c;padding:12px;font-size:8.5pt;color:#334155">
      Tenant ${esc(input.tenantId)} · canonical source ${esc(input.canonicalSourceHash || "historic")}
      · consent ${esc(input.consentVersion)} · release ${esc(input.releaseId)}.
      The final artifact is cryptographically sealed; the portable evidence bundle contains the event hash chain,
      certificate chain, validation report, trusted timestamp evidence and delivery ledger.
    </div>
  </div>`;
}

type AckField = { id: string; label: string; kind: string; page: number; responses: Array<{ recipientId: string; value: string; filledAt: Date }> };
function acknowledgementsHtml(fields: AckField[], signers: Array<{ id: string; name: string }>): string {
  if (!fields.length) return "";
  return `<div style="page-break-before:always;padding-top:6px"><h1 style="font-size:18pt">Shared field acknowledgements</h1>${fields.map((field) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <strong>${esc(field.label || field.kind)}</strong><div style="font-size:8pt;color:#94a3b8">Page ${field.page + 1} · field ${esc(field.id.slice(-8))}</div>
      <ul>${signers.map((signer) => {
        const answer = field.responses.find((response) => response.recipientId === signer.id);
        const text = !answer ? "Not answered" : ["signature", "initials", "stamp"].includes(field.kind) ? "signed" : field.kind === "checkbox" ? (answer.value === "true" ? "checked" : "unchecked") : answer.value.slice(0, 120);
        return `<li><strong>${esc(signer.name)}</strong> · ${esc(text)}${answer ? ` · ${esc(formatDateTime(answer.filledAt))}` : ""}</li>`;
      }).join("")}</ul>
    </div>`).join("")}</div>`;
}

async function extendedRequest(requestId: string): Promise<{
  sourceContext: Record<string, unknown> | null; canonicalSourceHash: string | null; consentVersion: string; releaseId: string;
  recipients: RecipientEvidence[];
}> {
  const meta = await basePrisma.$queryRaw<Array<{ sourceContext: Record<string, unknown> | null; canonicalSourceHash: string | null; consentVersion: string; releaseId: string | null }>>(Prisma.sql`
    SELECT "sourceContextJson" AS "sourceContext","canonicalSourceHash","consentVersion","releaseId"
      FROM "SignatureRequest" WHERE id=${requestId} LIMIT 1
  `);
  const recipients = await basePrisma.$queryRaw<RecipientEvidence[]>(Prisma.sql`
    SELECT id,name,email,phone,role,"signedAt","signerIp","signerUserAgent" AS "userAgent","signatureRef",
      "authMethod","assuranceLevel","authTransactionId"
      FROM "SignatureRecipient" WHERE "requestId"=${requestId} AND status='signed' ORDER BY "order",id
  `);
  return {
    sourceContext: meta[0]?.sourceContext ?? null,
    canonicalSourceHash: meta[0]?.canonicalSourceHash ?? null,
    consentVersion: meta[0]?.consentVersion ?? "historic",
    releaseId: meta[0]?.releaseId ?? signingReleaseId(),
    recipients,
  };
}

async function acquireCompletionLease(requestId: string, owner: string): Promise<boolean> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "SignatureRequest" SET status='rendering',"completionLeaseOwner"=${owner},
      "completionLeaseExpiresAt"=now()+interval '5 minutes',"stateVersion"="stateVersion"+1
     WHERE id=${requestId} AND "deletedAt" IS NULL
       AND (
         (status IN ('signatures_complete','in_progress','signing','active','sent','viewed')
           AND ("completionLeaseExpiresAt" IS NULL OR "completionLeaseExpiresAt" < now()))
         OR (status='rendering' AND ("completionLeaseExpiresAt" < now() OR "completionLeaseOwner"=${owner}))
       )
    RETURNING id
  `);
  return rows.length === 1;
}

/** Assemble, seal and atomically register the immutable completed artifact. */
export async function completeSignatureRequest(requestId: string): Promise<void> {
  const existing = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { status: true } });
  if (!existing || isRequestClosed(existing.status)) return;
  const leaseOwner = crypto.randomUUID();
  if (!(await acquireCompletionLease(requestId, leaseOwner))) return;

  let storedName: string | null = null;
  let timestampTokenRef: string | null = null;
  let sourceSigned = false;
  let wonLeadId: string | null = null;
  try {
    const req = await prisma.signatureRequest.findUnique({
      where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } },
    });
    if (!req || !req.tenantId || isRequestClosed(req.status)) {
      await basePrisma.$executeRaw`
        UPDATE "SignatureRequest" SET "completionLeaseOwner"=NULL,"completionLeaseExpiresAt"=NULL
         WHERE id=${requestId} AND "completionLeaseOwner"=${leaseOwner}
      `.catch(() => {});
      return;
    }
    const doc = parseDocument(req.snapshotJson);
    if (!doc) throw new Error("Frozen document snapshot is invalid");
    const extra = await extendedRequest(requestId);
    if (!extra.sourceContext || !extra.canonicalSourceHash) {
      throw new Error("Envelope has no frozen canonical source; reissue it before completion");
    }
    const allSigners = req.recipients.filter((recipient) => recipient.role !== "viewer");
    // Workflow graphs pre-materialise recipients on every possible branch. Once
    // the interpreter reaches End, untouched pending recipients are off-path and
    // are not parties to the executed contract. Sent/viewed/declined rows remain
    // in scope and therefore still block completion unless they signed.
    const signers = req.workflowGraphJson
      ? allSigners.filter((recipient) => recipient.status !== "pending")
      : allSigners;
    if (!signers.length || signers.some((recipient) => recipient.status !== "signed")) {
      throw new Error("Envelope cannot complete until every required signer has signed");
    }
    const pendingApprovals = await prisma.approvalStep.count({ where: { requestId, status: "pending" } });
    if (pendingApprovals) throw new Error("Envelope cannot complete while an approval is pending");
    const uploaderId = req.createdById || (await resolveTenantActor())?.id || null;
    if (!uploaderId) throw new Error("No tenant actor can own the filed signed document");

    const recipientRows = await Promise.all(extra.recipients.map(async (row) => ({ ...row, image: await sigImg(row.signatureRef) })));
    const nameByRecipient = new Map(req.recipients.map((row) => [row.id, row.signedName || row.name]));
    const fields = await prisma.signatureField.findMany({ where: { requestId, filledAt: { not: null } } });
    const stampedFields: StampField[] = [];
    for (const field of fields) {
      const base = { page: field.page, x: field.x, y: field.y, width: field.width, height: field.height, kind: field.kind };
      if (["signature", "initials", "stamp"].includes(field.kind)) {
        const image = await sigImg(field.value);
        if (image) stampedFields.push({ ...base, image, label: field.recipientId ? nameByRecipient.get(field.recipientId) : "" });
      } else if (field.kind === "checkbox") stampedFields.push({ ...base, text: field.value === "true" ? "✓" : "" });
      else stampedFields.push({ ...base, text: field.value ?? "" });
    }
    const shared = await prisma.signatureField.findMany({
      where: { requestId, recipientId: null }, include: { responses: true }, orderBy: [{ page: "asc" }, { y: "asc" }, { x: "asc" }, { id: "asc" }],
    });
    const context = extra.sourceContext;
    const html = renderDocumentHtml(doc, context, logoDataUri(), {
      hideOverlays: true,
      stampedFields,
      appendHtml: certificateHtml({
        title: req.title, requestId, tenantId: req.tenantId, canonicalSourceHash: extra.canonicalSourceHash,
        consentVersion: extra.consentVersion, releaseId: extra.releaseId, rows: recipientRows,
      }) + acknowledgementsHtml(shared.map((field) => ({
        id: field.id, label: field.label, kind: field.kind, page: field.page,
        responses: field.responses.map((response) => ({ recipientId: response.recipientId, value: response.value, filledAt: response.filledAt })),
      })), signers.map((row) => ({ id: row.id, name: row.signedName || row.name }))),
    });

    const rendered = await htmlToPdf(html);
    const seal = await sealPdfWithEvidence(rendered, { reason: `Signed: ${req.title}`, name: "Denago Cape Town" });
    const pdf = seal.pdf;
    const hash = crypto.createHash("sha256").update(pdf).digest("hex");
    storedName = await saveFile(pdf, `${req.title} (signed).pdf`, "application/pdf");
    await registerArtifactUpload({ tenantId: req.tenantId, envelopeId: requestId, kind: "signed_pdf", objectRef: storedName, bytes: pdf });
    if (seal.timestampToken) {
      timestampTokenRef = await saveFile(seal.timestampToken, `${req.title}.rfc3161.tsr`, "application/timestamp-reply");
      await registerArtifactUpload({ tenantId: req.tenantId, envelopeId: requestId, kind: "timestamp_token", objectRef: timestampTokenRef, bytes: seal.timestampToken });
    }

    const firstSigner = signers.find((row) => row.status === "signed");
    const signerName = firstSigner?.signedName || firstSigner?.name || "Customer";
    await prisma.$transaction(async (tx) => {
      if (req.quoteId) await tx.$executeRaw`SELECT id FROM "Quote" WHERE id=${req.quoteId} FOR UPDATE`;
      if (req.jobCardId) await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id=${req.jobCardId} FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM "SignatureRequest" WHERE id=${requestId} FOR UPDATE`;
      const document = await tx.document.create({
        data: {
          tenantId: req.tenantId,
          fileName: `${req.title} (signed).pdf`, storedName, mimeType: "application/pdf", sizeBytes: pdf.length,
          quoteId: req.quoteId, jobCardId: req.jobCardId, contactId: req.contactId, tag: "signed", uploadedById: uploaderId,
        },
      });
      const claimed = await tx.signatureRequest.updateMany({
        where: { id: requestId, status: "rendering" },
        data: { status: "sealed", completedAt: null, signedPdfRef: storedName, signedPdfHash: hash, signedDocId: document.id },
      });
      if (claimed.count !== 1) throw new CompletionLost();
      await tx.$executeRaw`UPDATE "SignatureRequest" SET "completionLeaseOwner"=NULL,"completionLeaseExpiresAt"=NULL WHERE id=${requestId}`;

      if (req.quoteId) {
        const signed = await tx.quote.updateMany({
          where: { id: req.quoteId, deletedAt: null, supersededAt: null, signedAt: null },
          data: { signedAt: new Date(), signedByName: signerName, status: "accepted", declinedAt: null, declineReason: null, signedPdfHash: hash },
        });
        if (signed.count === 1) {
          sourceSigned = true;
          const quote = await tx.quote.findUnique({ where: { id: req.quoteId }, select: { leadId: true } });
          if (quote?.leadId) {
            await tx.$executeRaw`SELECT id FROM "Lead" WHERE id=${quote.leadId} FOR UPDATE`;
            const won = await tx.lead.updateMany({ where: { id: quote.leadId, deletedAt: null, status: "open" }, data: { status: "won" } });
            if (won.count === 1) wonLeadId = quote.leadId;
          }
        } else {
          const quote = await tx.quote.findUnique({ where: { id: req.quoteId }, select: { signedAt: true, deletedAt: true, supersededAt: true } });
          if (!quote || quote.deletedAt || quote.supersededAt || !quote.signedAt) throw new SourceCompletionLost();
        }
      } else if (req.jobCardId) {
        const signed = await tx.jobCard.updateMany({ where: { id: req.jobCardId, deletedAt: null, signedAt: null }, data: { signedAt: new Date(), signedByName: signerName } });
        if (signed.count === 1) sourceSigned = true;
        else {
          const job = await tx.jobCard.findUnique({ where: { id: req.jobCardId }, select: { signedAt: true, deletedAt: true } });
          if (!job || job.deletedAt || !job.signedAt) throw new SourceCompletionLost();
        }
      }

      await recordLegalArtifact({
        tenantId: req.tenantId, envelopeId: requestId, documentId: document.id, objectRef: storedName!, sha256: hash,
        sizeBytes: pdf.length, certificateFingerprint: seal.certificateFingerprint, certificateChain: seal.certificateChain,
        keyId: seal.keyId, trustPolicy: seal.trustPolicy, timestampTokenRef,
        validationReport: seal.validationReport,
      }, tx);
      await markArtifactState({ tenantId: req.tenantId, objectRef: storedName!, kind: "signed_pdf", envelopeId: requestId, state: "sealed" }, tx);
      if (timestampTokenRef) await markArtifactState({ tenantId: req.tenantId, objectRef: timestampTokenRef, kind: "timestamp_token", envelopeId: requestId, state: "retained" }, tx);
      await tx.signatureEvent.create({
        data: {
          tenantId: req.tenantId, requestId, type: "sealed", actor: "system", channel: "worker",
          metadata: {
            hash, legalDocumentId: document.id, certificateFingerprint: seal.certificateFingerprint,
            trustPolicy: seal.trustPolicy, timestampTokenRef, validation: seal.validationReport,
            canonicalSourceHash: extra.canonicalSourceHash,
          },
        },
      });
      await tx.$executeRaw`
        UPDATE "SigningOutboxJob" SET payload=${JSON.stringify({
          id: req.id,
          title: req.title,
          quoteId: req.quoteId,
          jobCardId: req.jobCardId,
          signedByName: signerName,
          signedPdfHash: hash,
          signedDocId: document.id,
          sourceSigned,
          wonLeadId,
        })}::jsonb,"updatedAt"=now()
        WHERE "idempotencyKey"=${`post-complete:${requestId}`}
      `;
      await tx.$executeRaw`
        UPDATE "SignatureRequest" SET status='distributing',"stateVersion"="stateVersion"+1
         WHERE id=${requestId} AND status='sealed'
      `;
    });
  } catch (error) {
    const committed = storedName
      ? await basePrisma.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT status FROM "SignatureRequest" WHERE id=${requestId} AND "signedPdfRef"=${storedName}
            AND status IN ('sealed','distributing','completed') LIMIT 1
        `).catch(() => [])
      : [];
    // deleteFile is retain-only: it records delayed orphan candidates and never
    // treats an ambiguous commit acknowledgement as permission to delete bytes.
    if (!committed.length && storedName) await deleteFile(storedName).catch(() => {});
    if (!committed.length && timestampTokenRef) await deleteFile(timestampTokenRef).catch(() => {});

    if (error instanceof SourceCompletionLost) {
      await basePrisma.$executeRaw`
        UPDATE "SignatureRequest" SET status='failed_manual_intervention',"failedAt"=now(),
          "failureCode"='source_completion_lost',"completionLeaseOwner"=NULL,"completionLeaseExpiresAt"=NULL
         WHERE id=${requestId} AND status='rendering' AND "completionLeaseOwner"=${leaseOwner}
      `.catch(() => {});
      return;
    }
    if (!committed.length) {
      await basePrisma.$executeRaw`
        UPDATE "SignatureRequest" SET status='signatures_complete',"failureCode"=${error instanceof Error ? error.message.slice(0, 200) : "completion_failed"},
          "completionLeaseOwner"=NULL,"completionLeaseExpiresAt"=NULL
         WHERE id=${requestId} AND status='rendering' AND "completionLeaseOwner"=${leaseOwner}
      `.catch(() => {});
    }
    if (error instanceof CompletionLost || committed.length) return;
    throw error;
  }
}
