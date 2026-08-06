import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { formatDate } from "@/lib/format";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import type { DocumentModel } from "@/lib/doceditor/model";
import { freezeDocumentGlobals } from "@/lib/signing/freezeDocument";
import { currentTenantScope } from "@/lib/tenantScope";
import { newSignCapability } from "./tokens";
import { captureFrozenSourceContext, canonicalHash } from "./frozenSource";
import { signingReleaseId } from "./securityConfig";
import { registerArtifactUpload, markArtifactState } from "./artifactCustody";

export type RequestSource = {
  documentId?: string | null;
  quoteId?: string | null;
  jobCardId?: string | null;
  contactId?: string | null;
  templateId?: string | null;
};

async function resolveTenantId(opts: { tenantId?: string | null; createdById?: string | null; source: RequestSource; client?: Prisma.TransactionClient }): Promise<string> {
  const scoped = opts.tenantId ?? currentTenantScope()?.tenantId;
  if (scoped) return scoped;
  const db = opts.client ?? prisma;
  if (opts.createdById) {
    const user = await db.user.findUnique({ where: { id: opts.createdById }, select: { tenantId: true } });
    if (user?.tenantId) return user.tenantId;
  }
  if (opts.source.quoteId) {
    const row = await db.quote.findUnique({ where: { id: opts.source.quoteId }, select: { tenantId: true } });
    if (row?.tenantId) return row.tenantId;
  }
  if (opts.source.jobCardId) {
    const row = await db.jobCard.findUnique({ where: { id: opts.source.jobCardId }, select: { tenantId: true } });
    if (row?.tenantId) return row.tenantId;
  }
  if (opts.source.contactId) {
    const row = await db.contact.findUnique({ where: { id: opts.source.contactId }, select: { tenantId: true } });
    if (row?.tenantId) return row.tenantId;
  }
  throw new Error("Signing envelope creation requires an explicit tenant owner");
}

export async function createSignatureRequestFromDoc(opts: {
  doc: DocumentModel;
  title: string;
  unsignedPdfRef: string | null;
  source: RequestSource;
  ordering?: "parallel" | "sequential";
  message?: string;
  createdById?: string | null;
  tenantId?: string | null;
  identityPolicy?: "ES1_LINK" | "ES2_EMAIL_OTP" | "ES2_SMS_OTP" | "ES2_EMAIL_SMS" | "ES2_AUTHENTICATED_PORTAL" | "ES3_PASSKEY" | "ES3_IDENTITY_PROVIDER" | "AES_ACCREDITED";
  client?: Prisma.TransactionClient;
}): Promise<{ id: string; recipients: number; fields: number }> {
  const tenantId = await resolveTenantId(opts);
  const frozenDoc = freezeDocumentGlobals(opts.doc, {
    ...companyTokens(await getCompanyProfile()),
    "date.today": formatDate(new Date()),
  });
  const sourceContext = await captureFrozenSourceContext(opts.source.quoteId, opts.source.jobCardId);
  const sourceHash = canonicalHash({ document: frozenDoc, context: sourceContext });
  const workflowHash = frozenDoc.recipients.length ? canonicalHash(frozenDoc.recipients) : null;
  const configuredPolicy = process.env.SIGNING_IDENTITY_DEFAULT as typeof opts.identityPolicy;
  const policy = opts.identityPolicy ?? configuredPolicy ?? "ES2_EMAIL_OTP";

  const writes = async (db: Prisma.TransactionClient) => {
    const request = await db.signatureRequest.create({
      data: {
        tenantId,
        title: opts.title,
        status: "prepared",
        ordering: opts.ordering ?? "parallel",
        message: opts.message ?? null,
        documentId: opts.source.documentId ?? null,
        quoteId: opts.source.quoteId ?? null,
        jobCardId: opts.source.jobCardId ?? null,
        contactId: opts.source.contactId ?? null,
        templateId: opts.source.templateId ?? null,
        snapshotJson: frozenDoc as object,
        unsignedPdfRef: opts.unsignedPdfRef,
        createdById: opts.createdById ?? null,
      },
    });
    if (opts.unsignedPdfRef) {
      await registerArtifactUpload({ tenantId, envelopeId: request.id, kind: "unsigned_pdf", objectRef: opts.unsignedPdfRef }, db);
      await markArtifactState({ tenantId, envelopeId: request.id, kind: "unsigned_pdf", objectRef: opts.unsignedPdfRef, state: "referenced" }, db);
    }
    await db.$executeRaw`
      UPDATE "SignatureRequest" SET "identityPolicy"=${policy},
        "assuranceLevel"=${policy === "ES1_LINK" ? "ES-1" : policy.startsWith("ES2") ? "ES-2" : policy.startsWith("ES3") ? "ES-3" : "AES"},
        "sourceContextJson"=${JSON.stringify(sourceContext)}::jsonb,
        "canonicalSourceHash"=${sourceHash},"workflowHash"=${workflowHash},"releaseId"=${signingReleaseId()}
      WHERE id=${request.id} AND "tenantId"=${tenantId}
    `;

    const idMap = new Map<string, string>();
    for (let index = 0; index < frozenDoc.recipients.length; index += 1) {
      const recipient = frozenDoc.recipients[index];
      const capability = newSignCapability();
      const row = await db.signatureRecipient.create({
        data: {
          tenantId,
          requestId: request.id,
          name: recipient.name || `Recipient ${index + 1}`,
          email: recipient.email || null,
          role: recipient.role,
          order: index,
          color: recipient.color,
          token: capability.digest,
        },
      });
      await db.$executeRaw`
        UPDATE "SignatureRecipient" SET "tokenCiphertext"=${capability.ciphertext},
          "tokenIssuedAt"=${capability.issuedAt},"tokenExpiresAt"=${capability.expiresAt}
        WHERE id=${row.id} AND "tenantId"=${tenantId}
      `;
      idMap.set(recipient.id, row.id);
    }

    const fieldsData = frozenDoc.pages.flatMap((page, pageIndex) =>
      page.overlayFields.map((field) => ({
        tenantId,
        requestId: request.id,
        recipientId: field.recipientId ? idMap.get(field.recipientId) ?? null : null,
        kind: field.kind,
        page: pageIndex,
        x: field.anchor.x,
        y: field.anchor.y,
        width: field.width,
        height: field.height,
        required: field.required,
        label: field.label,
      })),
    );
    if (fieldsData.length) await db.signatureField.createMany({ data: fieldsData });
    await db.signatureEvent.create({
      data: {
        tenantId,
        requestId: request.id,
        type: "created",
        actor: "system",
        metadata: { title: opts.title, recipients: frozenDoc.recipients.length, fields: fieldsData.length, sourceHash, policy },
      },
    });
    return { id: request.id, recipients: frozenDoc.recipients.length, fields: fieldsData.length };
  };

  const result = opts.client ? await writes(opts.client) : await prisma.$transaction((tx) => writes(tx));
  await logAudit({
    action: "signing.create",
    summary: `Created signature request “${opts.title}”`,
    entityType: "SignatureRequest",
    entityId: result.id,
  });
  return result;
}
