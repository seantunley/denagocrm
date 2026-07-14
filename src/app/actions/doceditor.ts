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
import { createSignatureRequestFromDoc } from "@/lib/signing/service";
import { saveFile } from "@/lib/storage";

type SignPrepResult = { ok: boolean; requestId?: string; message: string };

const BASE = "/settings/documents/builder";

/** Create a new doc-editor template seeded with a blank A4 proposal, then open it. */
export async function createDocEditorTemplate(formData: FormData) {
  const user = await requireOwner();
  const name = String(formData.get("name") ?? "").trim() || "Untitled proposal";
  const key = String(formData.get("key") ?? "proposal").trim() || "proposal";
  const created = await prisma.docBuilderTemplate.create({
    data: { name, key, data: blankDocument(name) as object, createdById: user.id },
  });
  await logAudit({ action: "doceditor.create", summary: `Created document “${name}”`, entityType: "DocBuilderTemplate", entityId: created.id, user });
  revalidatePath(BASE);
  redirect(`/doc-editor/${created.id}`);
}

/**
 * Generate a PDF from a doc-editor template + a record and file it in the Document
 * repository (linked to the quote/job card & contact). Redirects to the PDF.
 */
export async function generateDocEditorDocument(formData: FormData) {
  const user = await requireOwner();
  const templateId = String(formData.get("templateId") ?? "").trim();
  const quoteId = String(formData.get("quoteId") ?? "").trim() || undefined;
  const jobCardId = String(formData.get("jobCardId") ?? "").trim() || undefined;
  if (!templateId) return;

  const res = await generateDocEditorPdf({ templateId, quoteId, jobCardId });
  if (!res) return;

  const storedName = await saveFile(res.buffer, `${res.title}.pdf`, "application/pdf");
  const doc = await prisma.document.create({
    data: {
      fileName: `${res.title}.pdf`, storedName, mimeType: "application/pdf", sizeBytes: res.buffer.length,
      quoteId: res.quoteId, jobCardId: res.jobCardId, contactId: res.contactId,
      tag: "generated-pdf", uploadedById: user.id,
    },
  });
  await logAudit({ action: "doceditor.generate", summary: `Generated “${res.title}” to the document repository`, entityType: "Document", entityId: doc.id, user });
  revalidatePath(BASE);
  redirect(`/api/files/${doc.id}`);
}

/**
 * Prepare a document for signing: generate + file the unsigned PDF, then create a
 * SignatureRequest envelope (recipients, per-recipient tokens, placed fields, audit).
 * Dispatch (email/WhatsApp) happens from the signing hub in a later phase.
 */
export async function sendDocForSigning(templateId: string, quoteId?: string | null, jobCardId?: string | null): Promise<SignPrepResult> {
  const user = await requireOwner();
  const tpl = await getBuilderTemplate(templateId);
  if (!tpl) return { ok: false, message: "Template not found" };
  const doc = parseDocument(tpl.data);
  if (!doc) return { ok: false, message: "This document is empty." };
  if (doc.recipients.length === 0) return { ok: false, message: "Add at least one recipient (and signature fields) to the template first." };

  const res = await generateDocEditorPdf({ templateId, quoteId, jobCardId });
  if (!res) return { ok: false, message: "Could not generate the PDF." };

  const storedName = await saveFile(res.buffer, `${res.title}.pdf`, "application/pdf");
  const document = await prisma.document.create({
    data: {
      fileName: `${res.title}.pdf`, storedName, mimeType: "application/pdf", sizeBytes: res.buffer.length,
      quoteId: res.quoteId, jobCardId: res.jobCardId, contactId: res.contactId, tag: "for-signing", uploadedById: user.id,
    },
  });

  const created = await createSignatureRequestFromDoc({
    doc,
    title: res.title,
    unsignedPdfRef: storedName,
    source: { documentId: document.id, quoteId: res.quoteId, jobCardId: res.jobCardId, contactId: res.contactId, templateId },
    createdById: user.id,
  });
  await logAudit({ action: "doceditor.sign", summary: `Prepared “${res.title}” for signing`, entityType: "SignatureRequest", entityId: created.id, user });
  revalidatePath(BASE);
  return { ok: true, requestId: created.id, message: `Signature request created — ${created.recipients} recipient(s), ${created.fields} field(s). Open the Signatures hub to send it.` };
}

/** Create a template pre-built as the branded "Standard" quotation, then open it. */
export async function createStandardQuoteTemplate() {
  const user = await requireOwner();
  const doc = standardQuoteTemplate();
  const created = await prisma.docBuilderTemplate.create({
    data: { name: "Standard quotation", key: "quote", data: doc as object, createdById: user.id },
  });
  await logAudit({ action: "doceditor.create", summary: "Created “Standard quotation” from the branded preset", entityType: "DocBuilderTemplate", entityId: created.id, user });
  revalidatePath(BASE);
  redirect(`/doc-editor/${created.id}`);
}

/**
 * Persist the editor's document JSON. The payload is untrusted client content, so
 * it is validated against the Zod schema before it touches the database.
 */
export async function saveDocEditor(id: string, doc: unknown): Promise<{ ok: boolean; error?: string }> {
  const user = await requireOwner();
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, error: "Invalid document structure" };

  const existing = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) return { ok: false, error: "Not found" };

  await prisma.docBuilderTemplate.update({ where: { id }, data: { data: parsed.data as object } });
  await logAudit({ action: "doceditor.save", summary: `Saved document “${parsed.data.title}”`, entityType: "DocBuilderTemplate", entityId: id, user });
  return { ok: true };
}
