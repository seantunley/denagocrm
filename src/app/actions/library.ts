"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
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
    await prisma.libraryDocument.create({
      data: {
        name,
        category,
        versions: {
          create: {
            version: 1,
            fileName: file.fileName,
            storedName: file.url,
            mimeType: file.mimeType || "application/octet-stream",
            sizeBytes: file.sizeBytes,
            uploadedById: user.id,
          },
        },
      },
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
  await prisma.libraryVersion.create({
    data: {
      documentId,
      version: nextVersion,
      fileName: file.fileName,
      storedName: file.url,
      mimeType: file.mimeType || "application/octet-stream",
      sizeBytes: file.sizeBytes,
      note,
      uploadedById: user.id,
    },
  });
  await prisma.libraryDocument.update({ where: { id: documentId }, data: { updatedAt: new Date() } });
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
