"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { saveFile } from "@/lib/storage";

const MAX_SIZE = 25 * 1024 * 1024;

export async function createLibraryDocument(formData: FormData) {
  const user = await requireUser();
  const nameOverride = String(formData.get("name") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim() || null;
  const files = formData
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) return;

  const added: string[] = [];
  for (const file of files) {
    if (file.size > MAX_SIZE) throw new Error(`“${file.name}” exceeds the 25 MB limit`);
    // custom name only applies when uploading a single file; otherwise use each file's name
    const name =
      files.length === 1 && nameOverride
        ? nameOverride
        : file.name.replace(/\.[^.]+$/, "");

    const mimeType = file.type || "application/octet-stream";
    const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name, mimeType);

    await prisma.libraryDocument.create({
      data: {
        name,
        category,
        versions: {
          create: {
            version: 1,
            fileName: file.name,
            storedName,
            mimeType,
            sizeBytes: file.size,
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

export async function addLibraryVersion(documentId: string, formData: FormData) {
  const user = await requireUser();
  const file = formData.get("file");
  const note = String(formData.get("note") ?? "").trim() || null;
  if (!(file instanceof File) || file.size === 0) return;
  if (file.size > MAX_SIZE) throw new Error("File exceeds 25 MB limit");

  const doc = await prisma.libraryDocument.findUniqueOrThrow({
    where: { id: documentId },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  });
  const nextVersion = (doc.versions[0]?.version ?? 0) + 1;

  const mimeType = file.type || "application/octet-stream";
  const storedName = await saveFile(Buffer.from(await file.arrayBuffer()), file.name, mimeType);

  await prisma.libraryVersion.create({
    data: {
      documentId,
      version: nextVersion,
      fileName: file.name,
      storedName,
      mimeType,
      sizeBytes: file.size,
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
  const user = await requireUser();
  const reason = String(formData.get("reason") ?? "").trim() || "No reason given";
  const doc = await softDeleteRecord("libraryDocument", id, reason, user.name);
  await logAudit({
    action: "trash.deleted",
    summary: `Moved library document “${doc.name}” to trash — ${reason}`,
    user,
  });
  revalidatePath("/library");
}
