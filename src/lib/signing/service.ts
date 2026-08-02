import "server-only";
import { Prisma } from "@prisma/client";
import { basePrisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { formatDate } from "@/lib/format";
import { getCompanyProfile, companyTokens } from "@/lib/companyProfile";
import type { DocumentModel } from "@/lib/doceditor/model";
import { freezeDocumentGlobals } from "@/lib/signing/freezeDocument";
import { newSignToken } from "./tokens";

export type RequestSource = {
  documentId?: string | null;
  quoteId?: string | null;
  jobCardId?: string | null;
  contactId?: string | null;
  templateId?: string | null;
};

export async function createSignatureRequestFromDoc(opts: {
  doc: DocumentModel;
  title: string;
  unsignedPdfRef: string | null;
  source: RequestSource;
  ordering?: "parallel" | "sequential";
  message?: string;
  createdById?: string | null;
  // Run all writes on this transaction client when provided, so the caller can
  // create the request + recipients + fields + event atomically (and under a
  // lock) — e.g. to guarantee at most one open request per quote/job card.
  client?: Prisma.TransactionClient;
}): Promise<{ id: string; recipients: number; fields: number }> {
  const { source } = opts;
  const frozenDoc = freezeDocumentGlobals(opts.doc, {
    ...companyTokens(await getCompanyProfile()),
    "date.today": formatDate(new Date()),
  });

  // The request + its recipients + fields + created event are ONE envelope — a
  // partial one (a request row with no recipients, say) is corrupt. Run them
  // atomically: on the caller's transaction when supplied, otherwise our own,
  // so a failure part-way leaves nothing behind.
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

    const idMap = new Map<string, string>();
    for (let index = 0; index < frozenDoc.recipients.length; index += 1) {
      const recipient = frozenDoc.recipients[index];
      const row = await db.signatureRecipient.create({
        data: {
          requestId: request.id,
          name: recipient.name || `Recipient ${index + 1}`,
          email: recipient.email || null,
          role: recipient.role,
          order: index,
          color: recipient.color,
          token: newSignToken(),
        },
      });
      idMap.set(recipient.id, row.id);
    }

    const fieldsData = frozenDoc.pages.flatMap((page, pageIndex) =>
      page.overlayFields.map((field) => ({
        requestId: request.id,
        recipientId: field.recipientId
          ? idMap.get(field.recipientId) ?? null
          : null,
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
    if (fieldsData.length) {
      await db.signatureField.createMany({ data: fieldsData });
    }

    await db.signatureEvent.create({
      data: {
        requestId: request.id,
        type: "created",
        actor: "system",
        metadata: {
          title: opts.title,
          recipients: frozenDoc.recipients.length,
          fields: fieldsData.length,
        },
      },
    });

    return { id: request.id, recipients: frozenDoc.recipients.length, fields: fieldsData.length };
  };

  // Own transaction on basePrisma when the caller didn't supply one — the same
  // client the record-signing caller already builds its transaction on, so both
  // entry points create the envelope through an identical path.
  const result = opts.client
    ? await writes(opts.client)
    : await basePrisma.$transaction((tx) => writes(tx));

  // Best-effort audit AFTER the envelope commits — logAudit runs on its own
  // connection/transaction, so keeping it out of the request transaction means
  // an audit hiccup can't roll back a committed request, and a rolled-back
  // request never logs a phantom creation.
  await logAudit({
    action: "signing.create",
    summary: `Created signature request “${opts.title}”`,
    entityType: "SignatureRequest",
    entityId: result.id,
  });

  return result;
}

// createOrReuseSignatureRequestFromDoc lived here: an atomic create-or-reuse
// keyed on a hash of the resolved document, arbitrated by a partial unique
// index. Its only caller was sendDocForSigning — the document editor's
// "Prepare for signing" — which existed so the same template could be re-sent
// against the same record without minting a second envelope and a second email.
//
// Every remaining path already guarantees that a different way: startRecordSigning
// locks the SOURCE record row FOR UPDATE and short-circuits on an existing open
// request, so the record itself — not a content hash — is the mutex. The
// fingerprint column and its index went with the function (see migration
// 20260802_drop_signing_fingerprint).
