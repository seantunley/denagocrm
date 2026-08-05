import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { formatDate } from "@/lib/format";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import type { DocumentModel } from "@/lib/doceditor/model";
import { freezeDocumentGlobals } from "@/lib/signing/freezeDocument";
import { signingSecurityMode } from "./securityPolicy";
import { createProtectedBearerToken } from "./tokenVault";

export type RequestSource = {
  documentId?: string | null;
  quoteId?: string | null;
  jobCardId?: string | null;
  contactId?: string | null;
  templateId?: string | null;
};

export type SigningIdentityMode = "link" | "email_otp";

export async function createSignatureRequestFromDoc(opts: {
  doc: DocumentModel;
  title: string;
  unsignedPdfRef: string | null;
  source: RequestSource;
  ordering?: "parallel" | "sequential";
  message?: string;
  createdById?: string | null;
  identityMode?: SigningIdentityMode;
  client?: Prisma.TransactionClient;
}): Promise<{ id: string; recipients: number; fields: number; identityMode: SigningIdentityMode }> {
  const { source } = opts;
  const frozenDoc = freezeDocumentGlobals(opts.doc, {
    ...companyTokens(await getCompanyProfile()),
    "date.today": formatDate(new Date()),
  });
  const signers = frozenDoc.recipients.filter((recipient) => recipient.role !== "viewer");
  const allSignersHaveEmail = signers.length > 0 && signers.every((recipient) => Boolean(recipient.email?.trim()));
  const identityMode: SigningIdentityMode =
    opts.identityMode ?? (signingSecurityMode() === "strict" && allSignersHaveEmail ? "email_otp" : "link");

  const writes = async (db: Prisma.TransactionClient) => {
    const request = await db.signatureRequest.create({
      data: {
        title: opts.title,
        status: "draft",
        ordering: opts.ordering ?? "parallel",
        message: opts.message ?? null,
        documentId: source.documentId ?? null,
        quoteId: source.quoteId ?? null,
        jobCardId: source.jobCardId ?? null,
        contactId: source.contactId ?? null,
        templateId: source.templateId ?? null,
        snapshotJson: frozenDoc as object,
        unsignedPdfRef: opts.unsignedPdfRef,
        createdById: opts.createdById ?? null,
      },
    });
    await db.$executeRaw`
      UPDATE "SignatureRequest" SET "identityMode" = ${identityMode}
      WHERE "id" = ${request.id}
    `;

    const idMap = new Map<string, string>();
    for (let index = 0; index < frozenDoc.recipients.length; index += 1) {
      const recipient = frozenDoc.recipients[index];
      const bearer = createProtectedBearerToken();
      const row = await db.signatureRecipient.create({
        data: {
          requestId: request.id,
          name: recipient.name || `Recipient ${index + 1}`,
          email: recipient.email || null,
          role: recipient.role,
          order: index,
          color: recipient.color,
          // The URL secret is encrypted at rest; tokenHash is corrected to the
          // plaintext digest immediately below in this same transaction.
          token: bearer.stored,
        },
      });
      await db.$executeRaw`
        UPDATE "SignatureRecipient" p
        SET "tokenHash" = ${bearer.hash}
        WHERE p."id" = ${row.id}
          AND p."requestId" = ${request.id}
          AND p."tenantId" = (
            SELECT r."tenantId" FROM "SignatureRequest" r WHERE r."id" = ${request.id}
          )
      `;
      idMap.set(recipient.id, row.id);
    }

    const fieldsData = frozenDoc.pages.flatMap((page, pageIndex) =>
      page.overlayFields.map((field) => ({
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
        requestId: request.id,
        type: "created",
        actor: "system",
        metadata: {
          title: opts.title,
          recipients: frozenDoc.recipients.length,
          fields: fieldsData.length,
          identityMode,
          bearerTokens: "aes-256-gcm+sha256",
        },
      },
    });

    return { id: request.id, recipients: frozenDoc.recipients.length, fields: fieldsData.length, identityMode };
  };

  const result = opts.client
    ? await writes(opts.client)
    : await basePrisma.$transaction((tx) => writes(tx));

  await logAudit({
    action: "signing.create",
    summary: `Created signature request “${opts.title}” (${result.identityMode})`,
    entityType: "SignatureRequest",
    entityId: result.id,
  });
  return result;
}
