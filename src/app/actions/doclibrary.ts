"use server";

import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { blockSchema } from "@/lib/doceditor/model";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { isDocEditorLibraryItem } from "@/lib/studioClauses";
import { libraryContentSchema, librarySectionSchema, sectionBlocks, sectionFromBlocks } from "@/lib/doceditor/librarySection";

/**
 * The doc-editor's content library.
 *
 * Every statement here names the ACTING WORKSPACE. They used to name none: the
 * list read every library item in the database, a save was stamped with no
 * workspace, and delete took an id from the browser and soft-deleted whatever
 * row it named. Under tenant enforcement the guarded client added the workspace;
 * with enforcement off nothing did, so one workspace could list and delete
 * another's saved content. A caller who may manage layouts is not thereby the
 * owner of the row whose id they posted.
 */

const saveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(60).default(""),
  /** One or more blocks (the original shape) — or a section. At least one of the two must hold something. */
  blocks: z.array(blockSchema).default([]),
  section: librarySectionSchema.optional(),
});

/** Save a block, a row or a freely placed arrangement to the content library. The payload is validated. */
export async function saveLibraryItem(input: unknown): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false };
    const section = parsed.data.section ?? sectionFromBlocks(parsed.data.blocks);
    const blocks = sectionBlocks(section);
    if (blocks.length === 0) return { ok: false };
    await prisma.reusableBlock.create({
      data: {
        tenantId: await actingTenantId(),
        name: parsed.data.name,
        category: parsed.data.category || null,
        // `blocks` stays beside the section: it is how an item is recognised as the
        // doc-editor's (studioClauses.ts), and what an older reader inserts.
        contentJson: { kind: "doceditor", blocks, section } as object,
      },
    });
    await logAudit({ action: "doclibrary.save", summary: `Saved “${parsed.data.name}” to the content library`, entityType: "ReusableBlock", user });
    return { ok: true };
  });
}

/** This workspace's doc-editor library items, newest first. */
export async function listLibraryItems() {
  return withActingStaffScope(async () => {
    await requirePermission("docbuilder.manage");
    try {
      const rows = await prisma.reusableBlock.findMany({
        where: { tenantId: await actingTenantId(), deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 200,
      });
      return rows.filter(isDocEditorLibraryItem).flatMap((r) => {
        // What is stored is re-validated on the way out: a row this code did not
        // write (or an old one) cannot put a malformed block into the editor.
        const content = libraryContentSchema.safeParse(r.contentJson);
        if (!content.success) return [];
        const section = content.data.section ?? sectionFromBlocks(content.data.blocks);
        return sectionBlocks(section).length ? [{ id: r.id, name: r.name, category: r.category, blocks: sectionBlocks(section), section }] : [];
      });
    } catch {
      return [];
    }
  });
}

export async function deleteLibraryItem(id: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    // Counted: an id from another workspace, or one already deleted, changes nothing and says so.
    const gone = await prisma.reusableBlock.updateMany({ where: { id, tenantId: await actingTenantId(), deletedAt: null }, data: { deletedAt: new Date() } });
    if (gone.count !== 1) return { ok: false };
    await logAudit({ action: "doclibrary.delete", summary: "Deleted a content-library item", entityType: "ReusableBlock", entityId: id, user });
    return { ok: true };
  });
}
