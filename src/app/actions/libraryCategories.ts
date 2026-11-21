"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope, withActingTenantWrite } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { requireDocumentAccess, requirePermission } from "@/lib/permissions";
import { getWorkspaceSetting, putWorkspaceSetting } from "@/lib/settings";
import { softDeleteRecord } from "@/lib/trash";
import { deleteFile, readFile, saveFile } from "@/lib/storage";
import { SYSTEM_TAG_LABELS } from "@/lib/documentLabels";
import { LIBRARY_CATEGORIES_KEY, chosenLibraryCategory, parseLibraryCategories } from "@/lib/libraryCategories";

/* The Library's categories (lib/libraryCategories.ts): the list, an item's category, and a filed document moved in. */

async function categoriesFor(tenantId: string): Promise<string[]> {
  return parseLibraryCategories(await getWorkspaceSetting(tenantId, LIBRARY_CATEGORIES_KEY));
}

/** The categories offered on the Library, one per line. Whoever manages the Library. */
export async function saveLibraryCategoryList(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requirePermission("library.manage");
      const tenantId = await actingTenantId();
      const list = parseLibraryCategories(String(formData.get("categories") ?? ""));
      await putWorkspaceSetting(tenantId, LIBRARY_CATEGORIES_KEY, list.join("\n"));
      await logAudit({ action: "settings.library_categories", summary: `Library categories: ${list.join(", ")}`, user });
      revalidatePath("/documents");
      return { success: "Saved" };
    }),
  );
}

/** Change a Library item's category (Brochure, Price list…) — from the workspace's list only. */
export async function setLibraryCategory(documentId: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requirePermission("library.manage");
      const tenantId = await actingTenantId();
      const doc = await prisma.libraryDocument.findFirst({ where: { id: documentId, tenantId, deletedAt: null }, select: { name: true, category: true } });
      if (!doc) refuse("That library document is no longer there — refresh the page.");
      const chosen = chosenLibraryCategory(formData.get("category"), await categoriesFor(tenantId), doc.category);
      if (!chosen.ok) refuse("Choose one of your Library categories.");
      const saved = await prisma.libraryDocument.updateMany({ where: { id: documentId, tenantId, deletedAt: null }, data: { category: chosen.category } });
      if (saved.count !== 1) refuse("That library document is no longer there — refresh the page.");
      await logAudit({ action: "library.category_changed", summary: `“${doc.name}” is now ${chosen.category ?? "uncategorised"} (was ${doc.category ?? "uncategorised"})`, user });
      revalidatePath("/documents");
      return { success: "Saved" };
    }),
  );
}

/**
 * A brochure or price list that was filed on a customer, vehicle or quote, MOVED to the Library under a category: a copy
 * of the file becomes a Library item (version 1), and the record's copy goes to the Trash (restorable for 60 days).
 * Needs the document's own access AND library.manage. A file the CRM itself filed (a signed copy, an invoice, a proof
 * of payment, a delivery note…) is paperwork on its record and is never moved.
 */
export async function moveDocumentToLibrary(documentId: string, formData: FormData) {
  return asActionResult(async () => {
    const user = await requireDocumentAccess(documentId, "documents.manage");
    await requirePermission("library.manage");
    const doc = await prisma.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, tenantId: true, fileName: true, storedName: true, mimeType: true, sizeBytes: true, tag: true },
    });
    if (!doc) refuse("That document is no longer there — refresh the page.");
    if (doc.tag && SYSTEM_TAG_LABELS[doc.tag]) refuse(`${SYSTEM_TAG_LABELS[doc.tag]} is paperwork on its record and stays there.`);
    const signed = await prisma.signatureRequest.count({ where: { documentId } });
    if (signed > 0) refuse("This document was sent for signature, so it stays on its record.");

    const tenantId = doc.tenantId ?? (await actingTenantId());
    const chosen = chosenLibraryCategory(formData.get("category"), await categoriesFor(tenantId));
    const category = chosen.ok ? chosen.category : null;
    if (!category) return refuse("Choose a Library category for it — for example Brochure or Price list.");
    const name = String(formData.get("name") ?? "").trim().slice(0, 120) || doc.fileName.replace(/\.[^.]+$/, "");

    // A copy of its own in the Library: the record's file goes to the Trash with its record link, restorable.
    const bytes = await readFile(doc.storedName, tenantId);
    const storedName = await saveFile(bytes, doc.fileName, doc.mimeType, tenantId);
    try {
      await withActingTenantWrite(async (tx, actingTenant) => {
        const owner = doc.tenantId ?? actingTenant;
        const created = await tx.libraryDocument.create({ data: { name, category, tenantId: owner } });
        await tx.libraryVersion.create({
          data: {
            documentId: created.id, version: 1, fileName: doc.fileName, storedName, mimeType: doc.mimeType,
            sizeBytes: bytes.length, note: "Moved from a customer's documents", uploadedById: user.id, tenantId: owner,
          },
        });
        const trashed = await softDeleteRecord("document", documentId, "Moved to the Library", user.name, tx);
        if (!trashed) refuse("That document is no longer there — refresh the page.");
      });
    } catch (error) {
      // Nothing names the copy: remove it rather than leave an orphan file.
      await deleteFile(storedName).catch(() => {});
      throw error;
    }
    await logAudit({ action: "document.moved_to_library", summary: `Moved “${doc.fileName}” to the Library as ${category}: “${name}”`, user });
    revalidatePath("/documents");
    return { success: `Moved to the Library — ${category}` };
  });
}
