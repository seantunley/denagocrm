"use server";

import { asActionResult, ActionRefusal, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, type PermissionUser } from "@/lib/permissions";
import { RECORD_UNAVAILABLE, canAccessBuilderRecord } from "@/lib/docbuilder/recordAccess";
import { logAudit } from "@/lib/audit";
import { documentSchema } from "@/lib/doceditor/model";
import { blankDocument, standardQuoteTemplate } from "@/lib/doceditor/factory";
import { portableDocumentSchema, externalImageCount } from "@/lib/doceditor/portable";
import { generateDocEditorPdf } from "@/lib/doceditor/generate";
import { getBuilderTemplate } from "@/lib/docbuilder/store";
import {
  parseBuilderRecord,
  recordMatchesTemplate,
  type BuilderRecordKind,
} from "@/lib/docbuilder/recordBinding";
import { saveFile } from "@/lib/storage";

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
  // Same message either way — "you may not" and "it does not exist" must not be
  // distinguishable, or this becomes an existence oracle for records the caller
  // cannot see. The decision itself lives in docbuilder/recordAccess.ts, because
  // the two API routes that render these same templates from these same ids need
  // exactly this answer and used to reach it a different way: not at all.
  if (record && !(await canAccessBuilderRecord(user, record))) {
    throw new ActionRefusal(RECORD_UNAVAILABLE);
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

/**
 * Create a document from a portable export — the other half of "Export →
 * Portable JSON", and the reason that format exists.
 *
 * Always creates a NEW document rather than overwriting the one open in the
 * editor: an import is somebody else's work arriving, not an edit to yours.
 */
export async function importDocEditorTemplate(
  raw: unknown,
): Promise<{ ok: boolean; error?: string; id?: string; name?: string; externalImages?: number }> {
  const user = await requirePermission("docbuilder.manage");
  const parsed = portableDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "That file is not a Denago document export. Use Export → Portable JSON on the document you want to copy.",
    };
  }
  const { name, key, document } = parsed.data;
  const created = await prisma.docBuilderTemplate.create({
    data: { name, key, data: document as object, createdById: user.id },
  });
  await logAudit({
    action: "doceditor.import",
    summary: `Imported document “${name}”`,
    entityType: "DocBuilderTemplate",
    entityId: created.id,
    user,
  });
  revalidatePath(BASE);
  return {
    ok: true,
    id: created.id,
    name,
    // Surfaced, not silently accepted: a linked image belongs to the tenant
    // that uploaded it and will not load here.
    externalImages: externalImageCount(document),
  };
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
