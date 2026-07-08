"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrm } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";

export type UploadedFileMeta = {
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

/** Records library documents after the browser uploaded the files directly to Blob storage. */
export async function registerLibraryDocuments(
  category: string | null,
  nameOverride: string | null,
  files: UploadedFileMeta[]
) {
  const user = await requireCrm();
  if (files.length === 0) return;
  const added: string[] = [];
  for (const f of files) {
    const name =
      files.length === 1 && nameOverride
        ? nameOverride
        : f.fileName.replace(/\.[^.]+$/, "");
    await prisma.libraryDocument.create({
      data: {
        name,
        category,
        versions: {
          create: {
            version: 1,
            fileName: f.fileName,
            storedName: f.url,
            mimeType: f.mimeType || "application/octet-stream",
            sizeBytes: f.sizeBytes,
            uploadedById: user.id,
          },
        },
      },
    });
    added.push(name);
  }
  await logAudit({
    action: "document.uploaded",
    summary:
      added.length === 1
        ? `Added “${added[0]}” (v1) to the document library`
        : `Added ${added.length} documents to the library: ${added.join(", ")}`,
    user,
  });
  revalidatePath("/library");
}

/** Records a new version after a direct browser upload. */
export async function registerLibraryVersion(
  documentId: string,
  note: string | null,
  f: UploadedFileMeta
) {
  const user = await requireCrm();
  const doc = await prisma.libraryDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const nextVersion = (doc.versions[0]?.version ?? 0) + 1;
  await prisma.libraryVersion.create({
    data: {
      documentId,
      version: nextVersion,
      fileName: f.fileName,
      storedName: f.url,
      mimeType: f.mimeType || "application/octet-stream",
      sizeBytes: f.sizeBytes,
      note,
      uploadedById: user.id,
    },
  });
  await prisma.libraryDocument.update({
    where: { id: documentId },
    data: { updatedAt: new Date() },
  });
  await logAudit({
    action: "document.uploaded",
    summary: `Uploaded v${nextVersion} of “${doc.name}”${note ? ` — ${note}` : ""}`,
    user,
  });
  revalidatePath("/library");
}

export async function deleteLibraryDocument(id: string, formData: FormData) {
  const user = await requireCrm();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const doc = await softDeleteRecord("libraryDocument", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved library document “${doc.name}” to trash — ${reason}`,
    user,
  });
  revalidatePath("/library");
}
