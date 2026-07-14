import "server-only";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import type { DocumentModel } from "@/lib/doceditor/model";
import { newSignToken } from "./tokens";

/**
 * Core signing-request service. Turns a document (its recipients + placed fields
 * + an unsigned PDF) into a persisted SignatureRequest envelope with per-recipient
 * tokens and an audit trail. Dispatch (email/WhatsApp) and the signing surface are
 * separate phases — this only creates the request in `draft`.
 */

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
}): Promise<{ id: string; recipients: number; fields: number }> {
  const { doc, source } = opts;

  const request = await prisma.signatureRequest.create({
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
      snapshotJson: doc as object, // frozen layout — the signer always sees what was sent
      unsignedPdfRef: opts.unsignedPdfRef,
      createdById: opts.createdById ?? null,
    },
  });

  // Recipients — assign signing order by document order; map doc-recipient id → row id.
  const idMap = new Map<string, string>();
  for (let i = 0; i < doc.recipients.length; i++) {
    const r = doc.recipients[i];
    const row = await prisma.signatureRecipient.create({
      data: {
        requestId: request.id,
        name: r.name || `Recipient ${i + 1}`,
        email: r.email || null,
        role: r.role,
        order: i,
        color: r.color,
        token: newSignToken(),
      },
    });
    idMap.set(r.id, row.id);
  }

  // Fields — flatten page overlay fields, remap recipient ids.
  const fieldsData = doc.pages.flatMap((page, p) =>
    page.overlayFields.map((f) => ({
      requestId: request.id,
      recipientId: f.recipientId ? idMap.get(f.recipientId) ?? null : null,
      kind: f.kind,
      page: p,
      x: f.anchor.x,
      y: f.anchor.y,
      width: f.width,
      height: f.height,
      required: f.required,
      label: f.label,
    }))
  );
  if (fieldsData.length) await prisma.signatureField.createMany({ data: fieldsData });

  await prisma.signatureEvent.create({
    data: { requestId: request.id, type: "created", actor: "system", metadata: { title: opts.title, recipients: doc.recipients.length, fields: fieldsData.length } },
  });
  await logAudit({ action: "signing.create", summary: `Created signature request “${opts.title}”`, entityType: "SignatureRequest", entityId: request.id });

  return { id: request.id, recipients: doc.recipients.length, fields: fieldsData.length };
}
