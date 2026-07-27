"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withTenantWrite } from "@/lib/tenantWrite";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";

export type UploadedFileMeta = {
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export async function registerLibraryDocuments(
  category: string | null,
  nameOverride: string | null,
  files: UploadedFileMeta[]
) {
  const user = await requirePermission("library.manage");
  if (files.length === 0) return;
  const added: string[] = [];
  for (const file of files) {
    const name = files.length === 1 && nameOverride
      ? nameOverride
      : file.fileName.replace(/\.[^.]+$/, "");
    // Atomic: document + its first version in ONE transaction, each stamped with the
    // owning tenant (the guard refuses a nested `versions.create`; the composite
    // (tenantId, documentId) FK ties the version to the doc). A failure creating the
    // version rolls back the orphan document.
    await withTenantWrite(async (tx, tenantId) => {
      const doc = await tx.libraryDocument.create({ data: { name, category, tenantId } });
      await tx.libraryVersion.create({
        data: {
          documentId: doc.id,
          version: 1,
          fileName: file.fileName,
          storedName: file.url,
          mimeType: file.mimeType || "application/octet-stream",
          sizeBytes: file.sizeBytes,
          uploadedById: user.id,
          tenantId,
        },
      });
    });
    added.push(name);
  }
  await logAudit({
    action: "document.uploaded",
    summary: added.length === 1
      ? `Added “${added[0]}” (v1) to the document library`
      : `Added ${added.length} documents to the library: ${added.join(", ")}`,
    user,
  });
  revalidatePath("/library");
}

export async function registerLibraryVersion(
  documentId: string,
  note: string | null,
  file: UploadedFileMeta
) {
  const user = await requirePermission("library.manage");
  const document = await prisma.libraryDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const nextVersion = (document.versions[0]?.version ?? 0) + 1;
  // Atomic: new version + the document's updatedAt bump in ONE transaction. The doc
  // was already authorised via the scoped findUniqueOrThrow above.
  await withTenantWrite(async (tx, tenantId) => {
    await tx.libraryVersion.create({
      data: {
        documentId,
        version: nextVersion,
        fileName: file.fileName,
        storedName: file.url,
        mimeType: file.mimeType || "application/octet-stream",
        sizeBytes: file.sizeBytes,
        note,
        uploadedById: user.id,
        tenantId,
      },
    });
    await tx.libraryDocument.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
  });
  await logAudit({
    action: "document.uploaded",
    summary: `Uploaded v${nextVersion} of “${document.name}”${note ? ` — ${note}` : ""}`,
    user,
  });
  revalidatePath("/library");
}

export async function deleteLibraryDocument(id: string, formData: FormData) {
  const user = await requirePermission("library.manage");
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const document = await softDeleteRecord("libraryDocument", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved library document “${document.name}” to trash — ${reason}`,
    user,
  });
  revalidatePath("/library");
}
