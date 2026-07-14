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
} from "@/lib/permissions";

const MAX_SIZE = 25 * 1024 * 1024;

async function requireUploadTargets(formData: FormData) {
  const contactId = String(formData.get("contactId") ?? "").trim();
  const vehicleId = String(formData.get("vehicleId") ?? "").trim();
  const jobCardId = String(formData.get("jobCardId") ?? "").trim();
  const quoteId = String(formData.get("quoteId") ?? "").trim();
  if (contactId) return requireContactAccess(contactId, "documents.upload");
  if (vehicleId) return requireVehicleAccess(vehicleId, "documents.upload");
  if (jobCardId) return requireJobCardAccess(jobCardId, "documents.upload");
  if (quoteId) return requireQuoteAccess(quoteId, "documents.upload");
  return requirePermission("documents.upload");
}

export async function uploadDocument(formData: FormData) {
  const user = await requireUploadTargets(formData);
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");

  const str = (k: string) => {
    const v = String(formData.get(k) ?? "").trim();
    return v === "" ? null : v;
  };

  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "application/octet-stream";
  const storedName = await saveFile(buffer, file.name, mimeType);

  const doc = await prisma.document.create({
    data: {
      fileName: file.name,
      storedName,
      mimeType,
      sizeBytes: file.size,
      contactId: str("contactId"),
      vehicleId: str("vehicleId"),
      jobCardId: str("jobCardId"),
      quoteId: str("quoteId"),
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
  const doc = await softDeleteRecord("document", id, reason, user.name);
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
  const data =
    kind === "contact"
      ? { contactId: targetId, vehicleId: null, quoteId: null, jobCardId: null }
      : kind === "vehicle"
        ? { vehicleId: targetId }
        : { quoteId: targetId };
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
