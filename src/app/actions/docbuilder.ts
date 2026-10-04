"use server";

import { asActionResult, refuse } from "@/lib/actionResult";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { requirePermission, requireAnyPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
// getBuilderTemplate, not a raw findUnique: it is where the module check lives.
import { getBuilderTemplate, listBuilderVersions } from "@/lib/docbuilder/store";
import { STANDARD_TEMPLATE_KEYS, standardTemplateFor, type StandardDocKey } from "@/lib/doceditor/standardTemplates";
import { withActingStaffScope } from "@/lib/actingScope";
import { requiredRecordKind } from "@/lib/docbuilder/recordBinding";
import { staleWordingWarnings } from "@/lib/doceditor/wordingCheck";
import { quoteWordingSettings } from "@/lib/quoteFromLead";

const BASE = "/document-studio";

/*
 * `createBuilderTemplate` and `saveBuilderData` used to live here and are gone.
 *
 * Both belonged to the retired Puck editor: create seeded `starterTemplate()`
 * (legacy `{root, zones, content}`), and save wrote its `data: unknown`
 * straight to the column with no schema validation at all. Nothing had
 * referenced either since the doc-editor replaced that editor — the builder
 * page creates through `createDocEditorTemplate` and the canvas saves through
 * `saveDocEditor`, which validates against `documentSchema` before it writes.
 *
 * Unreferenced is not unreachable: an exported "use server" function is a live
 * POST endpoint addressed by action id, not by whether any page renders a form
 * for it. Leaving them meant a `docbuilder.manage` holder could still write
 * arbitrary JSON into a template, and could still mint rows in the legacy
 * format — the exact shape ../lib/doceditor/legacy.ts now exists to read back.
 */

export async function renameBuilderTemplate(id: string, formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const name = String(formData.get("name") ?? "").trim();
    if (!name || !(await getBuilderTemplate(id))) return;
    await prisma.docBuilderTemplate.update({ where: { id }, data: { name } });
    await logAudit({ action: "docbuilder.rename", summary: `Renamed document to “${name}”`, entityType: "DocBuilderTemplate", entityId: id, user });
    revalidatePath(BASE);
  });
}

export async function setDefaultBuilderTemplate(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await getBuilderTemplate(id);
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
export async function publishBuilderVersion(id: string, label?: string): Promise<{ ok: boolean; version?: number; warnings?: string[] }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await getBuilderTemplate(id);
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
    // Non-blocking: published regardless, but typed-in wording that contradicts
    // the quote settings is pointed out (the owner's text is never rewritten).
    const warnings = requiredRecordKind(tpl.key) === "quote"
      ? staleWordingWarnings(tpl.data, await quoteWordingSettings())
      : [];
    return { ok: true, version, warnings };
  });
}

/**
 * Replace the working draft with the current standard layout for its type.
 *
 * Seeding never overwrites an existing template, so a workspace keeps the layout
 * it was first seeded with even after the standard layout improves. This is how
 * the owner picks the new one up.
 *
 * It must not change what customers get, and must not switch anything over:
 *  - The old draft is always kept in history as a version, so it can be restored.
 *  - Other document types move to this editor only when their layout HAS a
 *    published version (the switch in #672–#675), so for them that saved version
 *    stays UNPUBLISHED. Publishing it would turn the new renderer on.
 *  - Quotes are the exception: they already render from this editor with no
 *    switch, and a never-published quote layout renders its DRAFT. Replacing that
 *    draft would change live quotes, so its old draft is published as-is first.
 * The reset layout then waits in the draft until someone presses Publish.
 */
/** Types whose real documents render from this editor with no publish switch. */
const RENDERED_WITHOUT_PUBLISH_SWITCH = new Set(["quote"]);

export async function resetBuilderTemplateToStandard(id: string): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await getBuilderTemplate(id);
    if (!tpl || tpl.deletedAt) return { ok: false, error: "That template no longer exists." };
    if (!(STANDARD_TEMPLATE_KEYS as string[]).includes(tpl.key)) {
      return { ok: false, error: "There is no standard layout for this kind of document." };
    }
    const standard = standardTemplateFor(tpl.key as StandardDocKey, { automotive: await isModuleEnabled("automotive") });
    await prisma.$transaction(async (tx) => {
      const last = await tx.docBuilderVersion.findFirst({
        where: { templateId: id }, orderBy: { version: "desc" }, select: { version: true },
      });
      const version = (last?.version ?? 0) + 1;
      await tx.docBuilderVersion.create({
        data: { templateId: id, version, data: tpl.data as object, label: "Before reset to standard", publishedBy: user.name },
      });
      const draftIsLive = RENDERED_WITHOUT_PUBLISH_SWITCH.has(tpl.key) && tpl.publishedVersion == null;
      await tx.docBuilderTemplate.update({
        where: { id },
        data: {
          data: standard as object,
          ...(draftIsLive ? { status: "published", publishedVersion: version } : {}),
        },
      });
    });
    await logAudit({
      action: "docbuilder.reset_standard",
      summary: `Reset the draft of “${tpl.name}” to the standard ${tpl.key} layout (not live until published)`,
      entityType: "DocBuilderTemplate", entityId: id, user,
    });
    revalidatePath(`/doc-editor/${id}`);
    return { ok: true };
  });
}

/** Restore a prior version's JSON back onto the working draft. */
export async function restoreBuilderVersion(id: string, versionId: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await getBuilderTemplate(id);
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
  });
}

/** Version history for the editor's history panel (metadata only). */
export async function listBuilderVersionsAction(id: string) {
  return withActingStaffScope(async () => {
    await requireAnyPermission("docbuilder.view", "docbuilder.manage");
    if (!(await getBuilderTemplate(id))) return [];
    const rows = await listBuilderVersions(id);
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      label: r.label,
      publishedBy: r.publishedBy,
      publishedAt: r.publishedAt.toISOString(),
    }));
  });
}

export async function deleteBuilderTemplate(id: string) {
  return asActionResult(async () => {
    const user = await requirePermission("docbuilder.manage");
    const tpl = await getBuilderTemplate(id);
    if (!tpl || tpl.deletedAt) refuse("That template no longer exists.");
    await prisma.docBuilderTemplate.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({ action: "docbuilder.delete", summary: `Deleted document “${tpl.name}”`, entityType: "DocBuilderTemplate", entityId: id, user });
    revalidatePath(BASE);
  });
}
