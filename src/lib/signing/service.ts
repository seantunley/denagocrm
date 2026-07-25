import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
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
  // Stable fingerprint of template + source + resolved document (recipients,
  // fields, content) — see createOrReuseSignatureRequestFromDoc below.
  contentFingerprint?: string | null;
}): Promise<{ id: string; recipients: number; fields: number }> {
  const { source } = opts;
  const db = opts.client ?? prisma;
  const frozenDoc = freezeDocumentGlobals(opts.doc, {
    ...companyTokens(await getCompanyProfile()),
    "date.today": formatDate(new Date()),
  });

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
      contentFingerprint: opts.contentFingerprint ?? null,
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
  await logAudit({
    action: "signing.create",
    summary: `Created signature request “${opts.title}”`,
    entityType: "SignatureRequest",
    entityId: request.id,
  });

  return {
    id: request.id,
    recipients: frozenDoc.recipients.length,
    fields: fieldsData.length,
  };
}

/**
 * Atomic create-or-reuse by content fingerprint. A read-then-create (look up
 * an existing open request, create if none found) is a TOCTOU: two concurrent
 * calls can both see nothing and both create a request for the same document.
 * `contentFingerprint` is enforced unique among open (non-closed, non-deleted)
 * requests by a partial DB index (see migration
 * 20260725120000_signing_request_fingerprint), so the database — not this
 * read — is the single arbiter: the loser of the race gets a unique-constraint
 * violation here instead of a duplicate row, and reuses whatever the winner
 * created.
 */
export async function createOrReuseSignatureRequestFromDoc(
  opts: Parameters<typeof createSignatureRequestFromDoc>[0] & { contentFingerprint: string },
): Promise<{ id: string; recipients: number; fields: number; reused: boolean }> {
  try {
    const created = await createSignatureRequestFromDoc(opts);
    return { ...created, reused: false };
  } catch (error) {
    const isFingerprintConflict =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      (error.meta?.target as string[] | undefined)?.includes("contentFingerprint");
    if (!isFingerprintConflict) throw error;

    const winner = await prisma.signatureRequest.findFirst({
      where: { contentFingerprint: opts.contentFingerprint, deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, _count: { select: { recipients: true, fields: true } } },
    });
    if (!winner) throw error; // conflict resolved (e.g. voided) between our failed insert and this read — surface the original error
    return { id: winner.id, recipients: winner._count.recipients, fields: winner._count.fields, reused: true };
  }
}
