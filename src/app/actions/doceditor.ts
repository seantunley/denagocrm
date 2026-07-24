"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { documentSchema, parseDocument } from "@/lib/doceditor/model";
import { blankDocument, standardQuoteTemplate } from "@/lib/doceditor/factory";
import { generateDocEditorPdf } from "@/lib/doceditor/generate";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  parseBuilderRecord,
  recordMatchesTemplate,
  type BuilderRecordKind,
} from "@/lib/docbuilder/recordBinding";
import { createSignatureRequestFromDoc } from "@/lib/signing/service";
import { dispatchRequest } from "@/lib/signing/dispatch";
import { saveFile } from "@/lib/storage";

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

async function validatedBinding(
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
  return {
    template,
    quoteId: record?.kind === "quote" ? record.id : undefined,
    jobCardId: record?.kind === "jobcard" ? record.id : undefined,
  };
}

/** Create a new doc-editor template seeded with a blank A4 proposal, then open it. */
export async function createDocEditorTemplate(formData: FormData) {
  const user = await requireOwner();
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
  redirect(`/doc-editor/${created.id}`);
}

/** Generate and file a builder document bound to at most one compatible record. */
export async function generateDocEditorDocument(formData: FormData) {
  const user = await requireOwner();
  const templateId = String(formData.get("templateId") ?? "").trim();
  if (!templateId) return;

  const submittedRecord = String(formData.get("record") ?? "").trim();
  const record = submittedRecord
    ? parseBuilderRecord(submittedRecord)
    : legacyRecord(formData);
  if (submittedRecord && !record) throw new Error("Choose a valid record.");

  const { quoteId, jobCardId } = await validatedBinding(templateId, record);
  const result = await generateDocEditorPdf({
    templateId,
    quoteId,
    jobCardId,
  });
  if (!result) return;

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
  redirect(`/api/files/${document.id}`);
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
  const user = await requireOwner();
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
    binding = await validatedBinding(templateId, record);
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

  const result = await generateDocEditorPdf({
    templateId,
    quoteId: binding.quoteId,
    jobCardId: binding.jobCardId,
  });
  if (!result) return { ok: false, message: "Could not generate the PDF." };

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
      tag: "for-signing",
      uploadedById: user.id,
    },
  });

  const created = await createSignatureRequestFromDoc({
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
  });
  await logAudit({
    action: "doceditor.sign",
    summary: `Prepared “${result.title}” for signing`,
    entityType: "SignatureRequest",
    entityId: created.id,
    user,
  });
  revalidatePath(BASE);

  // "Send now": dispatch in the same step, mirroring signhub.sendRequest's guard
  // (a signer must be reachable) and its exact dispatchRequest call. If nobody is
  // reachable the request survives as a draft — we report that, not a failure.
  if (options?.dispatch) {
    const full = await prisma.signatureRequest.findUnique({
      where: { id: created.id },
      include: { recipients: true },
    });
    const reachable = full?.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone)) ?? [];
    if (reachable.length === 0) {
      return {
        ok: true,
        requestId: created.id,
        sent: false,
        message: "Prepared, but no signer has an email or phone yet — open the Signatures hub to add contact details and send.",
      };
    }
    const { notified } = await dispatchRequest(created.id);
    await logAudit({
      action: "signing.send",
      summary: `Sent “${result.title}” for signing`,
      entityType: "SignatureRequest",
      entityId: created.id,
      user,
    });
    revalidatePath("/signatures");
    revalidatePath(`/signatures/${created.id}`);
    return {
      ok: true,
      requestId: created.id,
      sent: true,
      notified,
      message: `Sent to ${notified} recipient(s).`,
    };
  }

  return {
    ok: true,
    requestId: created.id,
    sent: false,
    message: `Signature request created — ${created.recipients} recipient(s), ${created.fields} field(s). Open the Signatures hub to send it.`,
  };
}

/** Create a template pre-built as the branded standard quotation. */
export async function createStandardQuoteTemplate() {
  const user = await requireOwner();
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
  redirect(`/doc-editor/${created.id}`);
}

/** Persist validated editor JSON. */
export async function saveDocEditor(
  id: string,
  doc: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const user = await requireOwner();
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
