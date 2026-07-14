"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { buildMergeContext, renderInstanceHtml, htmlToPdf } from "@/lib/customDocs";
import { resolveBlocks } from "@/lib/mergeFields";
import {
  canAccessContact,
  canAccessLead,
  canAccessQuote,
  requirePermission,
  type PermissionKey,
  type PermissionUser,
} from "@/lib/permissions";

const EMPTY_DOC = [{ type: "paragraph", content: [] }];

async function assertLinkedScope(
  user: PermissionUser,
  links: { contactId?: string | null; leadId?: string | null; quoteId?: string | null }
) {
  if (links.contactId && !(await canAccessContact(user, links.contactId))) throw new Error("Contact access denied");
  if (links.leadId && !(await canAccessLead(user, links.leadId))) throw new Error("Lead access denied");
  if (links.quoteId && !(await canAccessQuote(user, links.quoteId))) throw new Error("Quote access denied");
}

async function requireDocInstanceAccess(id: string, permission: PermissionKey) {
  const user = await requirePermission(permission);
  const doc = await prisma.docInstance.findUniqueOrThrow({ where: { id } });
  await assertLinkedScope(user, doc);
  return { user, doc };
}

/* ── templates ───────────────────────────────────────────────────── */

export async function createStudioTemplate(formData: FormData) {
  const user = await requirePermission("document_templates.manage");
  const name = String(formData.get("name") ?? "").trim() || "Untitled template";
  const tpl = await prisma.customDocTemplate.create({
    data: { name, draftJson: EMPTY_DOC },
  });
  await logAudit({ action: "studio.template.created", summary: `Created studio template “${name}”`, user });
  redirect(`/settings/documents/studio/t/${tpl.id}`);
}

export async function saveStudioTemplate(
  id: string,
  data: { name: string; content: unknown }
): Promise<{ ok: boolean }> {
  await requirePermission("document_templates.manage");
  await prisma.customDocTemplate.update({
    where: { id },
    data: { name: data.name.trim() || "Untitled template", draftJson: data.content as object },
  });
  return { ok: true };
}

export async function publishStudioTemplate(id: string) {
  const user = await requirePermission("document_templates.manage");
  const tpl = await prisma.customDocTemplate.findUniqueOrThrow({
    where: { id },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const next = (tpl.versions[0]?.version ?? 0) + 1;
  await prisma.customDocVersion.create({
    data: { templateId: id, version: next, contentJson: tpl.draftJson as object, publishedBy: user.name },
  });
  await logAudit({
    action: "studio.template.published",
    summary: `Published “${tpl.name}” v${next}`,
    user,
  });
  revalidatePath(`/settings/documents/studio/t/${id}`);
  revalidatePath("/settings/documents");
}

export async function deleteStudioTemplate(id: string) {
  const user = await requirePermission("document_templates.manage");
  const tpl = await prisma.customDocTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ action: "studio.template.deleted", summary: `Deleted studio template “${tpl.name}”`, user });
  redirect("/settings/documents?tab=studio");
}

/* ── reusable blocks (inserted by value) ─────────────────────────── */

export async function createReusableBlock(formData: FormData) {
  const user = await requirePermission("document_templates.manage");
  const name = String(formData.get("name") ?? "").trim() || "Untitled clause";
  const row = await prisma.reusableBlock.create({
    data: { name, contentJson: EMPTY_DOC },
  });
  await logAudit({ action: "studio.block.created", summary: `Created reusable clause “${name}”`, user });
  redirect(`/settings/documents/studio/c/${row.id}`);
}

export async function saveReusableBlock(
  id: string,
  data: { title: string; content: unknown }
): Promise<{ ok: boolean }> {
  await requirePermission("document_templates.manage");
  await prisma.reusableBlock.update({
    where: { id },
    data: { name: data.title.trim() || "Untitled clause", contentJson: data.content as object },
  });
  return { ok: true };
}

export async function deleteReusableBlock(id: string) {
  await requirePermission("document_templates.manage");
  await prisma.reusableBlock.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/settings/documents");
}

/* ── document instances ──────────────────────────────────────────── */

export async function createDocInstance(formData: FormData) {
  const user = await requirePermission("documents.manage");
  const templateId = String(formData.get("templateId") ?? "").trim() || null;
  const title = String(formData.get("title") ?? "").trim() || "Untitled document";
  const contactId = String(formData.get("contactId") ?? "").trim() || null;
  const leadId = String(formData.get("leadId") ?? "").trim() || null;
  const quoteId = String(formData.get("quoteId") ?? "").trim() || null;
  await assertLinkedScope(user, { contactId, leadId, quoteId });

  let content: unknown = EMPTY_DOC;
  let templateVersionId: string | null = null;
  if (templateId) {
    const version = await prisma.customDocVersion.findFirst({
      where: { templateId },
      orderBy: { version: "desc" },
    });
    if (version) {
      content = version.contentJson;
      templateVersionId = version.id;
    } else {
      const tpl = await prisma.customDocTemplate.findUnique({ where: { id: templateId } });
      content = tpl?.draftJson ?? EMPTY_DOC;
    }
  }

  const ctx = await buildMergeContext({ contactId, leadId, quoteId, userName: user.name });
  const resolved = resolveBlocks(content, ctx);

  const doc = await prisma.docInstance.create({
    data: {
      title,
      contentJson: resolved as object,
      snapshotJson: ctx as object,
      contactId,
      leadId,
      quoteId,
      templateId,
      templateVersionId,
      createdById: user.id,
    },
  });
  await logAudit({
    action: "studio.doc.created",
    summary: `Created document “${title}”${templateId ? " from a template" : ""}`,
    contactId,
    leadId,
    user,
  });
  redirect(`/settings/documents/studio/d/${doc.id}`);
}

export async function saveDocInstance(
  id: string,
  data: { title: string; content: unknown }
): Promise<{ ok: boolean; error?: string }> {
  const { doc } = await requireDocInstanceAccess(id, "documents.manage");
  if (doc.status === "final") return { ok: false, error: "This document is finalised — duplicate it to edit." };
  await prisma.docInstance.update({
    where: { id },
    data: { title: data.title.trim() || doc.title, contentJson: data.content as object },
  });
  return { ok: true };
}

export async function finalizeDocInstance(id: string): Promise<{ ok: boolean; error?: string; pdfDocId?: string }> {
  const { user, doc } = await requireDocInstanceAccess(id, "documents.manage");

  try {
    const html = await renderInstanceHtml({ title: doc.title, contentJson: doc.contentJson });
    const pdf = await htmlToPdf(html);
    const storedName = await saveFile(pdf, `${doc.title}.pdf`, "application/pdf");
    const pdfDoc = await prisma.document.create({
      data: {
        fileName: `${doc.title}.pdf`,
        storedName,
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
        contactId: doc.contactId,
        quoteId: doc.quoteId,
        tag: "generated-pdf",
        uploadedById: user.id,
      },
    });
    await prisma.docInstance.update({
      where: { id },
      data: { status: "final", finalizedAt: new Date(), pdfDocId: pdfDoc.id },
    });
    await logAudit({
      action: "studio.doc.finalized",
      summary: `Finalised “${doc.title}” — PDF filed in the repository`,
      contactId: doc.contactId,
      leadId: doc.leadId,
      user,
    });
    revalidatePath(`/settings/documents/studio/d/${id}`);
    return { ok: true, pdfDocId: pdfDoc.id };
  } catch (error) {
    const { logError } = await import("@/lib/errorLog");
    await logError("studio-pdf", error);
    return { ok: false, error: error instanceof Error ? error.message : "PDF generation failed" };
  }
}

export async function deleteDocInstance(id: string) {
  const { user, doc } = await requireDocInstanceAccess(id, "documents.manage");
  await prisma.docInstance.update({ where: { id }, data: { deletedAt: new Date() } });
  await logAudit({ action: "studio.doc.deleted", summary: `Deleted document “${doc.title}”`, user });
  redirect("/settings/documents?tab=studio");
}
