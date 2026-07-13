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
import { getSigningAdapter, type SendResult } from "@/lib/doceditor/signing";
import { saveFile } from "@/lib/storage";

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
  const sign = formData.get("sign") === "on";
  if (!templateId) return;

  const res = await generateDocEditorPdf({ templateId, quoteId, jobCardId, sign });
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
 * Prepare a document for signing: seal + file the PDF, then hand recipients/fields
 * to the signing adapter (see @/lib/doceditor/signing). Returns the adapter result.
 */
export async function sendDocForSigning(templateId: string, quoteId?: string | null): Promise<SendResult> {
  const user = await requireOwner();
  const tpl = await getBuilderTemplate(templateId);
  if (!tpl) return { ok: false, provider: "", message: "Template not found" };
  const doc = parseDocument(tpl.data);
  if (!doc) return { ok: false, provider: "", message: "This document is empty." };

  const res = await generateDocEditorPdf({ templateId, quoteId, sign: true });
  if (!res) return { ok: false, provider: "", message: "Could not generate the PDF." };

  const storedName = await saveFile(res.buffer, `${res.title}.pdf`, "application/pdf");
  const document = await prisma.document.create({
    data: {
      fileName: `${res.title}.pdf`, storedName, mimeType: "application/pdf", sizeBytes: res.buffer.length,
      quoteId: res.quoteId, jobCardId: res.jobCardId, contactId: res.contactId, tag: "for-signing", uploadedById: user.id,
    },
  });
  const fields = doc.pages.flatMap((p, pi) => p.overlayFields.map((f) => ({
    kind: f.kind, recipientId: f.recipientId, page: pi, x: f.anchor.x, y: f.anchor.y, width: f.width, height: f.height, required: f.required, label: f.label,
  })));
  const result = await getSigningAdapter().send({ title: res.title, pdf: res.buffer, documentId: document.id, recipients: doc.recipients, fields });
  await logAudit({ action: "doceditor.sign", summary: `Prepared “${res.title}” for signing via ${result.provider}`, entityType: "Document", entityId: document.id, user });
  revalidatePath(BASE);
  return result;
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
