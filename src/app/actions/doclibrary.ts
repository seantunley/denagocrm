"use server";

import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { z } from "zod";
import { blockSchema } from "@/lib/doceditor/model";
import { withActingStaffScope } from "@/lib/actingScope";

const saveSchema = z.object({
  name: z.string().min(1),
  category: z.string().default(""),
  blocks: z.array(blockSchema).min(1),
});

/** Save one or more blocks to the reusable content library. Payload is validated. */
export async function saveLibraryItem(input: unknown): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success) return { ok: false };
    await prisma.reusableBlock.create({
      data: {
        name: parsed.data.name,
        category: parsed.data.category || null,
        contentJson: { kind: "doceditor", blocks: parsed.data.blocks } as object,
      },
    });
    await logAudit({ action: "doclibrary.save", summary: `Saved “${parsed.data.name}” to the content library`, entityType: "ReusableBlock", user });
    return { ok: true };
  });
}

/** List doc-editor library items (newest first). */
export async function listLibraryItems() {
  return withActingStaffScope(async () => {
    await requirePermission("docbuilder.manage");
    try {
      const rows = await prisma.reusableBlock.findMany({
        where: { deletedAt: null },
        orderBy: { updatedAt: "desc" },
        take: 200,
      });
      return rows
        .filter((r) => (r.contentJson as { kind?: string })?.kind === "doceditor")
        .map((r) => ({ id: r.id, name: r.name, category: r.category, blocks: (r.contentJson as { blocks: unknown[] }).blocks }));
    } catch {
      return [];
    }
  });
}

export async function deleteLibraryItem(id: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("docbuilder.manage");
    await prisma.reusableBlock.update({ where: { id }, data: { deletedAt: new Date() } });
    await logAudit({ action: "doclibrary.delete", summary: "Deleted a content-library item", entityType: "ReusableBlock", entityId: id, user });
    return { ok: true };
  });
}
