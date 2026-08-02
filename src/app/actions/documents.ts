"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { saveFile } from "@/lib/storage";
import { DOC_DEFS, defaultTemplate, mergeTemplate, isDocKey } from "@/lib/docTemplates";
import {
  requirePermission,
  requireDocumentAccess,
  requireContactAccess,
  requireVehicleAccess,
  requireJobCardAccess,
  requireQuoteAccess,
  type PermissionUser,
} from "@/lib/permissions";

const MAX_SIZE = 25 * 1024 * 1024;

type UploadTarget =
  | { kind: "contact"; contactId: string }
  | { kind: "vehicle"; vehicleId: string }
  | { kind: "jobCard"; jobCardId: string }
  | { kind: "quote"; quoteId: string }
  | { kind: "none" };

/**
 * Authorize a document upload against EXACTLY ONE parent record. The previous
 * version authorized the first non-empty target but then stored all four ids —
 * so a caller could pass one accessible contact id to pass the check and an
 * inaccessible vehicle/quote/job-card id in another field, linking the document
 * to a record they can't access (document access is the union of linked
 * records). Reject ambiguous submissions, authorize the single target, and hand
 * back exactly that target so the caller stores only it.
 */
async function authorizeUploadTarget(
  formData: FormData
): Promise<{ user: PermissionUser; target: UploadTarget }> {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const vehicleId = String(formData.get("vehicleId") ?? "").trim();
  const jobCardId = String(formData.get("jobCardId") ?? "").trim();
  const quoteId = String(formData.get("quoteId") ?? "").trim();
  const providedCount = [contactId, vehicleId, jobCardId, quoteId].filter(Boolean).length;
  if (providedCount > 1) {
    throw new Error("A document can be filed against only one record.");
  }
  if (contactId) return { user: await requireContactAccess(contactId, "documents.upload"), target: { kind: "contact", contactId } };
  if (vehicleId) return { user: await requireVehicleAccess(vehicleId, "documents.upload"), target: { kind: "vehicle", vehicleId } };
  if (jobCardId) return { user: await requireJobCardAccess(jobCardId, "documents.upload"), target: { kind: "jobCard", jobCardId } };
  if (quoteId) return { user: await requireQuoteAccess(quoteId, "documents.upload"), target: { kind: "quote", quoteId } };
  return { user: await requirePermission("documents.upload"), target: { kind: "none" } };
}

export async function uploadDocument(formData: FormData) {
  const { user, target } = await authorizeUploadTarget(formData);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");

  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const storedName = await saveFile(buffer, file.name, mimeType);

  const doc = await prisma.document.create({
    data: {
      fileName: file.name,
      storedName,
      mimeType,
      sizeBytes: file.size,
      // Only the single authorized target — never trust the other id fields.
      contactId: target.kind === "contact" ? target.contactId : null,
      vehicleId: target.kind === "vehicle" ? target.vehicleId : null,
      jobCardId: target.kind === "jobCard" ? target.jobCardId : null,
      quoteId: target.kind === "quote" ? target.quoteId : null,
      uploadedById: user.id,
    },
    include: { vehicle: true, jobCard: true },
  });
  await logAudit({
    action: "document.uploaded",
    summary: `Uploaded document “${file.name}”`,
    contactId: doc.contactId ?? doc.vehicle?.contactId ?? doc.jobCard?.contactId,
    user,
  });
  revalidatePath(String(formData.get("revalidate") ?? "/"));
}

export async function deleteDocument(id: string, revalidate: string, formData: FormData) {
  const user = await requireDocumentAccess(id, "documents.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  // Tenant-scoped at the WRITE as well as at the gate — softDeleteRecord runs
  // on basePrisma (RLS bypassed) and now applies the active tenant itself, so
  // another tenant's document id is a no-op rather than a deletion.
  const doc = await softDeleteRecord("document", id, reason, user.name);
  // Nothing matched: the id belongs to another tenant, or it is already gone.
  // Same destination requireDocumentAccess uses when its own gate refuses, so
  // the two failure modes look identical from outside — and, critically, no
  // audit entry is written for a deletion that did not happen.
  if (!doc) redirect("/documents");
  await logAudit({
    action: "trash.deleted",
    summary: `Moved document “${doc.fileName}” to trash — ${reason}`,
    contactId: doc.contactId,
    user,
  });
  revalidatePath(revalidate);
}

/* ── Typed generated-document templates ─────────────────────────── */

export async function createDocTemplate(formData: FormData) {
  const user = await requirePermission("document_templates.manage");
  const docType = String(formData.get("docType") ?? "");
  if (!isDocKey(docType)) return;
  const name = String(formData.get("name") ?? "").trim() || "Untitled";
  const baseId = String(formData.get("baseId") ?? "").trim();
  let config: object = defaultTemplate(docType) as object;
  if (baseId) {
    const base = await prisma.docTemplateRecord.findUnique({ where: { id: baseId } });
    if (base && base.docType === docType) config = mergeTemplate(docType, base.config) as object;
  }
  const hasDefault = await prisma.docTemplateRecord.count({
    where: { docType, isDefault: true, deletedAt: null },
  });
  const rec = await prisma.docTemplateRecord.create({
    data: { docType, name, config, isDefault: hasDefault === 0 },
  });
  await logAudit({ action: "doctemplate.created", summary: `Created ${DOC_DEFS[docType].label} template “${name}”`, user });
  redirect(`/settings/documents/t/${rec.id}`);
}

export async function updateDocTemplate(id: string, formData: FormData) {
  const user = await requirePermission("document_templates.manage");
  const rec = await prisma.docTemplateRecord.findUniqueOrThrow({ where: { id } });
  if (!isDocKey(rec.docType)) return;
  const key = rec.docType;
  const base = defaultTemplate(key);
  const config = {
    logoUrl: String(formData.get("logoUrl") ?? "").trim() || null,
    intro: String(formData.get("intro") ?? "").trim() || null,
    bodyText: String(formData.get("bodyText") ?? "").trim() || null,
    terms: String(formData.get("terms") ?? "").trim() || null,
    footerLines: String(formData.get("footerLines") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4),
    sections: Object.fromEntries(
      DOC_DEFS[key].sections.map((section) => [section.id, formData.get(`section_${section.id}`) === "on"])
    ),
    signature: {
      position: String(formData.get("sigPosition") ?? base.signature.position),
      dealerCounterSign: formData.get("dealerCounterSign") === "on",
    },
  };
  await prisma.docTemplateRecord.update({
    where: { id },
    data: { name: String(formData.get("name") ?? "").trim() || rec.name, config },
  });
  await logAudit({ action: "doctemplate.saved", summary: `Updated ${DOC_DEFS[key].label} template “${rec.name}”`, user });
  revalidatePath(`/settings/documents/t/${id}`);
}

export async function setDefaultDocTemplate(id: string) {
  const user = await requirePermission("document_templates.manage");
  const rec = await prisma.docTemplateRecord.findUniqueOrThrow({ where: { id } });
  await prisma.$transaction([
    prisma.docTemplateRecord.updateMany({ where: { docType: rec.docType }, data: { isDefault: false } }),
    prisma.docTemplateRecord.update({ where: { id }, data: { isDefault: true } }),
  ]);
  await logAudit({ action: "doctemplate.default", summary: `“${rec.name}” is now the default ${rec.docType} template`, user });
  revalidatePath("/settings/documents");
}

export async function duplicateDocTemplate(id: string) {
  const user = await requirePermission("document_templates.manage");
  const rec = await prisma.docTemplateRecord.findUniqueOrThrow({ where: { id } });
  const copy = await prisma.docTemplateRecord.create({
    data: { docType: rec.docType, name: `Copy of ${rec.name}`, config: rec.config as object },
  });
  await logAudit({ action: "doctemplate.created", summary: `Duplicated template “${rec.name}”`, user });
  redirect(`/settings/documents/t/${copy.id}`);
}

export async function deleteDocTemplate(id: string) {
  const user = await requirePermission("document_templates.manage");
  const rec = await prisma.docTemplateRecord.findUniqueOrThrow({ where: { id } });
  if (rec.isDefault) return;
  await prisma.docTemplateRecord.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ action: "doctemplate.deleted", summary: `Deleted template “${rec.name}”`, user });
  revalidatePath("/settings/documents");
}

export async function uploadTemplateLogo(id: string, formData: FormData) {
  const user = await requirePermission("document_templates.manage");
  const rec = await prisma.docTemplateRecord.findUniqueOrThrow({ where: { id } });
  if (!isDocKey(rec.docType)) return;
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > 2 * 1024 * 1024 || !file.type.startsWith("image/")) return;
  const url = await saveFile(Buffer.from(await file.arrayBuffer()), file.name || "logo.png", file.type);
  const config = { ...mergeTemplate(rec.docType, rec.config), logoUrl: url };
  await prisma.docTemplateRecord.update({ where: { id }, data: { config: config as object } });
  await logAudit({ action: "doctemplate.logo", summary: `Replaced the logo on template “${rec.name}”`, user });
  revalidatePath(`/settings/documents/t/${id}`);
}

/* ── Document repository ─────────────────────────────────────────── */

export async function renameDocument(id: string, formData: FormData) {
  const user = await requireDocumentAccess(id, "documents.manage");
  const fileName = String(formData.get("fileName") ?? "").trim();
  const tag = String(formData.get("tag") ?? "").trim() || null;
  if (!fileName) return;
  await prisma.document.update({ where: { id }, data: { fileName, tag } });
  await logAudit({ action: "document.updated", summary: `Renamed/re-tagged “${fileName}”`, user });
  revalidatePath("/settings/documents");
}

export async function moveDocument(id: string, formData: FormData) {
  const user = await requireDocumentAccess(id, "documents.manage");
  const [kind, targetId] = String(formData.get("target") ?? "").split(":");
  if (!targetId) return;
  if (kind === "contact") await requireContactAccess(targetId, "documents.manage");
  else if (kind === "vehicle") await requireVehicleAccess(targetId, "documents.manage");
  else if (kind === "quote") await requireQuoteAccess(targetId, "documents.manage");
  else return;
  // Clear every OTHER link on every move — otherwise moving a contact-filed doc
  // onto a vehicle/quote would keep the old contactId, leaving it linked to both
  // (and document access is the union of linked records).
  const data =
    kind === "contact"
      ? { contactId: targetId, vehicleId: null, jobCardId: null, quoteId: null }
      : kind === "vehicle"
        ? { vehicleId: targetId, contactId: null, jobCardId: null, quoteId: null }
        : { quoteId: targetId, contactId: null, vehicleId: null, jobCardId: null };
  const doc = await prisma.document.update({ where: { id }, data });
  await logAudit({ action: "document.moved", summary: `Re-filed “${doc.fileName}”`, user });
  revalidatePath("/settings/documents");
}

export async function uploadRepoDocument(formData: FormData) {
  const user = await requirePermission("documents.manage");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");
  const mimeType = file.type || "application/octet-stream";
  const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name, mimeType);
  await prisma.document.create({
    data: {
      fileName: file.name,
      storedName,
      mimeType,
      sizeBytes: file.size,
      tag: String(formData.get("tag") ?? "").trim() || null,
      uploadedById: user.id,
    },
  });
  await logAudit({ action: "document.uploaded", summary: `Uploaded “${file.name}” to the repository`, user });
  revalidatePath("/settings/documents");
}

export async function replaceDocument(id: string, formData: FormData) {
  const user = await requireDocumentAccess(id, "documents.manage");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");
  const old = await prisma.document.findUniqueOrThrow({ where: { id } });
  const mimeType = file.type || old.mimeType;
  const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name || old.fileName, mimeType);
  const next = await prisma.document.create({
    data: {
      fileName: file.name || old.fileName,
      storedName,
      mimeType,
      sizeBytes: file.size,
      contactId: old.contactId,
      vehicleId: old.vehicleId,
      jobCardId: old.jobCardId,
      quoteId: old.quoteId,
      tag: old.tag,
      uploadedById: user.id,
    },
  });
  await prisma.document.update({ where: { id }, data: { replacedById: next.id } });
  await logAudit({
    action: "document.versioned",
    summary: `New version of “${old.fileName}” (previous kept in history)`,
    user,
  });
  revalidatePath("/settings/documents");
}
