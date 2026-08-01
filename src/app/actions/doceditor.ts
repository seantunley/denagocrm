"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { canAccessJobCard, canAccessQuote, requirePermission, type PermissionUser } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { documentSchema, parseDocument } from "@/lib/doceditor/model";
import { blankDocument, standardQuoteTemplate } from "@/lib/doceditor/factory";
import { generateDocEditorPdf, resolveDocEditorContent, renderResolvedToPdf } from "@/lib/doceditor/generate";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  parseBuilderRecord,
  recordMatchesTemplate,
  type BuilderRecordKind,
} from "@/lib/docbuilder/recordBinding";
import { createOrReuseSignatureRequestFromDoc } from "@/lib/signing/service";
import { dispatchRequest } from "@/lib/signing/dispatch";
import { CLOSED_REQUEST_STATUSES } from "@/lib/signing/status";
import { saveFile, deleteFile } from "@/lib/storage";

type SignPrepResult = { ok: boolean; requestId?: string; message: string; sent?: boolean; notified?: number };

const BASE = "/settings/documents/builder";

function legacyRecord(formData: FormData): {
  kind: BuilderRecordKind;
  id: string;
} | null {
  const quoteId = String(formData.get("quoteId") ?? "").trim();
  const jobCardId = String(formData.get("jobCardId") ?? "").trim();
  if (quoteId && jobCardId) {
    throw new Error("Choose either a quote or a job card, not both.");
  }
  if (quoteId) return { kind: "quote", id: quoteId };
  if (jobCardId) return { kind: "jobcard", id: jobCardId };
  return null;
}

/**
 * Validate the template/record pairing AND the caller's access to that record.
 *
 * The kind check was already here; the access check was not. `docbuilder.manage`
 * is a capability — "this person may generate documents" — and the record id came
 * straight off the form, so a holder could render any quote's or job card's data
 * (pricing, customer details, line items) into a PDF and file it, whether or not
 * they may open that record. `sendDocForSigning` goes further and mails it.
 *
 * Mirrors `requireRecordSigningAccess` in recordSigning.ts: access to the
 * specific record, plus the permission that matches what is being done to it.
 */
async function validatedBinding(
  user: PermissionUser,
  templateId: string,
  record: { kind: BuilderRecordKind; id: string } | null,
) {
  const template = await getBuilderTemplate(templateId);
  if (!template) throw new Error("Template not found.");
  if (record && !recordMatchesTemplate(template.key, record.kind)) {
    throw new Error(
      record.kind === "quote"
        ? `The “${template.name}” template requires a job card record.`
        : `The “${template.name}” template requires a quote record.`,
    );
  }
  if (record) {
    const permitted =
      record.kind === "quote"
        ? await canAccessQuote(user, record.id)
        : await canAccessJobCard(user, record.id);
    // Same message either way — "you may not" and "it does not exist" must not
    // be distinguishable, or this becomes an existence oracle for records the
    // caller cannot see.
    if (!permitted) throw new ActionRefusal("That record isn't available.");
  }
  return {
    template,
    quoteId: record?.kind === "quote" ? record.id : undefined,
    jobCardId: record?.kind === "jobcard" ? record.id : undefined,
  };
}

/** Create a new doc-editor template seeded with a blank A4 proposal, then open it. */
export async function createDocEditorTemplate(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const name =
      String(formData.get("name") ?? "").trim() || "Untitled proposal";
    const key = String(formData.get("key") ?? "proposal").trim() || "proposal";
    const created = await prisma.docBuilderTemplate.create({
      data: {
        name,
        key,
        data: blankDocument(name) as object,
        createdById: user.id,
      },
    });
    await logAudit({
      action: "doceditor.create",
      summary: `Created document “${name}”`,
      entityType: "DocBuilderTemplate",
      entityId: created.id,
      user,
    });
    revalidatePath(BASE);
    return { redirectTo: `/doc-editor/${created.id}` };
  });
}

/** Generate and file a builder document bound to at most one compatible record. */
export async function generateDocEditorDocument(formData: FormData) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const templateId = String(formData.get("templateId") ?? "").trim();
    if (!templateId) refuse("Choose a template.");

    const submittedRecord = String(formData.get("record") ?? "").trim();
    const record = submittedRecord
      ? parseBuilderRecord(submittedRecord)
      : legacyRecord(formData);
    if (submittedRecord && !record) throw new ActionRefusal("Choose a valid record.");

    const { quoteId, jobCardId } = await validatedBinding(user, templateId, record);
    const result = await generateDocEditorPdf({
      templateId,
      quoteId,
      jobCardId,
    });
    if (!result) refuse("Could not build that document — check the template.");

    const storedName = await saveFile(
      result.buffer,
      `${result.title}.pdf`,
      "application/pdf",
    );
    const document = await prisma.document.create({
      data: {
        fileName: `${result.title}.pdf`,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: result.buffer.length,
        quoteId: result.quoteId,
        jobCardId: result.jobCardId,
        contactId: result.contactId,
        tag: "generated-pdf",
        uploadedById: user.id,
      },
    });
    await logAudit({
      action: "doceditor.generate",
      summary: `Generated “${result.title}” to the document repository`,
      entityType: "Document",
      entityId: document.id,
      user,
    });
    revalidatePath(BASE);
    return { redirectTo: `/api/files/${document.id}` };
  });
}

/**
 * Prepare a compatible builder document for signing. With `options.dispatch`,
 * the request is also SENT to recipients in the same step (the send wizard's
 * "Send now") — reusing the exact dispatch path the Signatures hub uses — instead
 * of only creating a draft the user must go to the hub to send.
 */
export async function sendDocForSigning(
  templateId: string,
  quoteId?: string | null,
  jobCardId?: string | null,
  options?: { dispatch?: boolean },
): Promise<SignPrepResult> {
  const user = await requirePermission("docbuilder.manage");
  if (quoteId && jobCardId) {
    return { ok: false, message: "Choose either a quote or a job card." };
  }
  const record = quoteId
    ? { kind: "quote" as const, id: quoteId }
    : jobCardId
      ? { kind: "jobcard" as const, id: jobCardId }
      : null;
  let binding;
  try {
    binding = await validatedBinding(user, templateId, record);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Invalid record binding.",
    };
  }

  const documentModel = parseDocument(binding.template.data);
  if (!documentModel) return { ok: false, message: "This document is empty." };
  if (documentModel.recipients.length === 0) {
    return {
      ok: false,
      message: "Add at least one recipient and signature field first.",
    };
  }

  // Resolve the bound document ONCE — template model + the actual quote/job-card/
  // contact values it merges in. This is the resolved artefact the fingerprint
  // below must represent, and (on the new-request path) exactly what we render to
  // PDF, so a request is never sent against different content than it was
  // fingerprinted on.
  const resolved = await resolveDocEditorContent(templateId, binding.quoteId, binding.jobCardId);
  if (!resolved) return { ok: false, message: "Could not resolve the document." };

  // Idempotency: a request is identified by an immutable fingerprint of the
  // RESOLVED artefact — template model AND the bound record's resolved values
  // (ctx). Hashing only templateId + record IDs + the template model would miss
  // a quote whose prices or customer details changed under the same id, and
  // wrongly reuse/redispatch the earlier PDF. The DB enforces at most one OPEN
  // request per fingerprint (see migration
  // 20260725120000_signing_request_fingerprint); this lookup is a fast-path, not
  // the source of truth — createOrReuseSignatureRequestFromDoc below is what
  // actually arbitrates a concurrent create race.
  const contentFingerprint = createHash("sha256")
    .update(JSON.stringify({
      templateId,
      quoteId: binding.quoteId ?? null,
      jobCardId: binding.jobCardId ?? null,
      document: documentModel,
      resolved: { doc: resolved.doc, ctx: resolved.ctx, title: resolved.title },
    }))
    .digest("hex");

  const existing = await prisma.signatureRequest.findFirst({
    where: {
      contentFingerprint,
      deletedAt: null,
      status: { notIn: [...CLOSED_REQUEST_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true },
  });

  // Already sent / in-progress for this exact content → a retry after a
  // successful send. Return it; never re-create or re-dispatch (that would
  // double-send links).
  if (existing && existing.status !== "draft") {
    return {
      ok: true,
      requestId: existing.id,
      sent: true,
      message: "A signing request for this document is already in progress — open the Signatures hub to manage it.",
    };
  }

  let requestId: string;
  let title: string;
  let prepared: { recipients: number; fields: number } | null = null;

  if (existing) {
    // Reuse the existing draft (retry of a prepare that already created it).
    requestId = existing.id;
    title = existing.title;
  } else {
    // Render the SAME resolved artefact we fingerprinted above — not a fresh
    // resolve, which could race a concurrent edit and store a PDF that no longer
    // matches contentFingerprint.
    const result = await renderResolvedToPdf(resolved);

    const storedName = await saveFile(result.buffer, `${result.title}.pdf`, "application/pdf");
    const document = await prisma.document.create({
      data: {
        fileName: `${result.title}.pdf`,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: result.buffer.length,
        quoteId: result.quoteId,
        jobCardId: result.jobCardId,
        contactId: result.contactId,
        tag: "for-signing",
        uploadedById: user.id,
      },
    });
    const created = await createOrReuseSignatureRequestFromDoc({
      doc: documentModel,
      title: result.title,
      unsignedPdfRef: storedName,
      source: {
        documentId: document.id,
        quoteId: result.quoteId,
        jobCardId: result.jobCardId,
        contactId: result.contactId,
        templateId,
      },
      createdById: user.id,
      contentFingerprint,
    });
    if (created.reused) {
      // We lost the fingerprint race: the winner has its own Document + PDF, so
      // the ones we generated a moment ago are orphans. Reconcile them — remove
      // the stored blob and soft-delete the Document row — so a concurrent
      // double-send doesn't litter the repository with an unreferenced
      // for-signing PDF. Best-effort: a cleanup failure must not fail the send
      // (the winner's request is valid regardless).
      await deleteFile(storedName).catch(() => {});
      await prisma.document
        .update({
          where: { id: document.id },
          data: { deletedAt: new Date(), deletedByName: "System", deleteReason: "Superseded by concurrent identical signing request" },
        })
        .catch(() => {});
    } else {
      await logAudit({
        action: "doceditor.sign",
        summary: `Prepared “${result.title}” for signing`,
        entityType: "SignatureRequest",
        entityId: created.id,
        user,
      });
    }
    requestId = created.id;
    title = result.title;
    prepared = { recipients: created.recipients, fields: created.fields };
  }
  revalidatePath(BASE);

  // "Send now": dispatch in the same step. dispatchRequest only marks REACHABLE
  // recipients "sent" and returns TRUTHFUL delivery counts, so we log a send and
  // claim success only when a message actually went out.
  if (options?.dispatch) {
    const dispatch = await dispatchRequest(requestId);
    revalidatePath("/signatures");
    revalidatePath(`/signatures/${requestId}`);
    if (dispatch.notified > 0) {
      await logAudit({
        action: "signing.send",
        summary: `Sent “${title}” for signing`,
        entityType: "SignatureRequest",
        entityId: requestId,
        user,
      });
      const stranded = dispatch.unreachable > 0 ? ` ${dispatch.unreachable} signer(s) had no contact channel and remain pending.` : "";
      return { ok: true, requestId, sent: true, notified: dispatch.notified, message: `Sent to ${dispatch.notified} recipient(s).${stranded}` };
    }
    // Nothing delivered — never log a successful send. Report why.
    return {
      ok: true,
      requestId,
      sent: false,
      message: dispatch.unreachable > 0
        ? "Prepared, but no signer has a usable contact channel — add an email or phone in the Signatures hub, then send."
        : "Prepared, but the message could not be delivered — open the Signatures hub to retry.",
    };
  }

  return {
    ok: true,
    requestId,
    sent: false,
    message: prepared
      ? `Signature request created — ${prepared.recipients} recipient(s), ${prepared.fields} field(s). Open the Signatures hub to send it.`
      : "Existing draft reused. Open the Signatures hub to send it.",
  };
}

/** Create a template pre-built as the branded standard quotation. */
export async function createStandardQuoteTemplate() {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const doc = standardQuoteTemplate();
    const created = await prisma.docBuilderTemplate.create({
      data: {
        name: "Standard quotation",
        key: "quote",
        data: doc as object,
        createdById: user.id,
      },
    });
    await logAudit({
      action: "doceditor.create",
      summary: "Created “Standard quotation” from the branded preset",
      entityType: "DocBuilderTemplate",
      entityId: created.id,
      user,
    });
    revalidatePath(BASE);
    return { redirectTo: `/doc-editor/${created.id}` };
  });
}

/** Persist validated editor JSON. */
export async function saveDocEditor(
  id: string,
  doc: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requirePermission("docbuilder.manage");
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) {
    return { ok: false, error: "Invalid document structure" };
  }

  const existing = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) {
    return { ok: false, error: "Not found" };
  }

  await prisma.docBuilderTemplate.update({
    where: { id },
    data: { data: parsed.data as object },
  });
  await logAudit({
    action: "doceditor.save",
    summary: `Saved document “${parsed.data.title}”`,
    entityType: "DocBuilderTemplate",
    entityId: id,
    user,
  });
  return { ok: true };
}
