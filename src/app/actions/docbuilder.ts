"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission, requireAnyPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { starterTemplate } from "@/lib/docbuilder/blocks";
import { listBuilderVersions } from "@/lib/docbuilder/store";

const BASE = "/settings/documents/builder";

export async function createBuilderTemplate(formData: FormData) {
  const user = await requirePermission("docbuilder.manage");
  const name = String(formData.get("name") ?? "").trim();
  const key = String(formData.get("key") ?? "custom").trim() || "custom";
  if (!name) return;
  const created = await prisma.docBuilderTemplate.create({
    data: { name, key, data: starterTemplate() as object, createdById: user.id },
  });
  await logAudit({
    action: "docbuilder.create",
    summary: `Created document “${name}” (${key})`,
    entityType: "DocBuilderTemplate",
    entityId: created.id,
    user,
  });
  revalidatePath(BASE);
  redirect(`/doc-editor/${created.id}`);
}

/** Persist the Puck document tree from the editor. */
export async function saveBuilderData(id: string, data: unknown): Promise<{ ok: boolean }> {
  const user = await requirePermission("docbuilder.manage");
  const existing = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) return { ok: false };
  await prisma.docBuilderTemplate.update({ where: { id }, data: { data: data as object } });
  await logAudit({
    action: "docbuilder.save",
    summary: `Saved layout for document “${existing.name}”`,
    entityType: "DocBuilderTemplate",
    entityId: id,
    user,
  });
  revalidatePath(`${BASE}/${id}`);
  return { ok: true };
}

export async function renameBuilderTemplate(id: string, formData: FormData) {
  const user = await requirePermission("docbuilder.manage");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;
  await prisma.docBuilderTemplate.update({ where: { id }, data: { name } });
  await logAudit({ action: "docbuilder.rename", summary: `Renamed document to “${name}”`, entityType: "DocBuilderTemplate", entityId: id, user });
  revalidatePath(BASE);
}

export async function setDefaultBuilderTemplate(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await prisma.docBuilderTemplate.findUnique({ where: { id } });
    if (!tpl || tpl.deletedAt) refuse("That template no longer exists.");
    await prisma.$transaction([
      prisma.docBuilderTemplate.updateMany({ where: { key: tpl.key }, data: { isDefault: false } }),
      prisma.docBuilderTemplate.update({ where: { id }, data: { isDefault: true } }),
    ]);
    await logAudit({ action: "docbuilder.default", summary: `Set “${tpl.name}” as default ${tpl.key}`, entityType: "DocBuilderTemplate", entityId: id, user });
    revalidatePath(BASE);
  });
}

/** Snapshot the current draft as an immutable, restorable version and mark it published. */
export async function publishBuilderVersion(id: string, label?: string): Promise<{ ok: boolean; version?: number }> {
  const user = await requirePermission("docbuilder.manage");
  const tpl = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!tpl || tpl.deletedAt) return { ok: false };
  const last = await prisma.docBuilderVersion.findFirst({
    where: { templateId: id }, orderBy: { version: "desc" }, select: { version: true },
  });
  const version = (last?.version ?? 0) + 1;
  await prisma.$transaction([
    prisma.docBuilderVersion.create({
      data: { templateId: id, version, data: tpl.data as object, label: label?.trim() || null, publishedBy: user.name },
    }),
    prisma.docBuilderTemplate.update({ where: { id }, data: { status: "published", publishedVersion: version } }),
  ]);
  await logAudit({
    action: "docbuilder.publish",
    summary: `Published version ${version} of “${tpl.name}”`,
    entityType: "DocBuilderTemplate", entityId: id, user,
  });
  revalidatePath(`/doc-editor/${id}`);
  revalidatePath(BASE);
  return { ok: true, version };
}

/** Restore a prior version's JSON back onto the working draft. */
export async function restoreBuilderVersion(id: string, versionId: string): Promise<{ ok: boolean }> {
  const user = await requirePermission("docbuilder.manage");
  const tpl = await prisma.docBuilderTemplate.findUnique({ where: { id } });
  if (!tpl || tpl.deletedAt) return { ok: false };
  const ver = await prisma.docBuilderVersion.findUnique({ where: { id: versionId } });
  if (!ver || ver.templateId !== id) return { ok: false };
  await prisma.docBuilderTemplate.update({ where: { id }, data: { data: ver.data as object } });
  await logAudit({
    action: "docbuilder.restore",
    summary: `Restored “${tpl.name}” to version ${ver.version}`,
    entityType: "DocBuilderTemplate", entityId: id, user,
  });
  revalidatePath(`/doc-editor/${id}`);
  revalidatePath(BASE);
  return { ok: true };
}

/** Version history for the editor's history panel (metadata only). */
export async function listBuilderVersionsAction(id: string) {
  await requireAnyPermission("docbuilder.view", "docbuilder.manage");
  const rows = await listBuilderVersions(id);
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    label: r.label,
    publishedBy: r.publishedBy,
    publishedAt: r.publishedAt.toISOString(),
  }));
}

export async function deleteBuilderTemplate(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await prisma.docBuilderTemplate.findUnique({ where: { id } });
    if (!tpl || tpl.deletedAt) refuse("That template no longer exists.");
    await prisma.docBuilderTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({ action: "docbuilder.delete", summary: `Deleted document “${tpl.name}”`, entityType: "DocBuilderTemplate", entityId: id, user });
    revalidatePath(BASE);
  });
}
