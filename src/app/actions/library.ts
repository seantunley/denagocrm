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

/**
 * `url` arrives as a server-action argument, so it is whatever the caller sent —
 * the browser uploads straight to Blob storage and then tells us where it put
 * the file. Every OTHER storedName in this codebase is a saveFile() return
 * value; this is the one that comes from outside, and it was stored unchecked.
 *
 * That made it a file path and a fetch target: readFile() handed a non-https
 * ref to path.join(UPLOAD_DIR, ref) and an https one to fetch(). storage.ts now
 * refuses both shapes at the boundary, but this is where the bad value would
 * have entered, so it is refused here too — a bad ref should never reach the
 * database, not merely fail on the way out.
 */
function assertBlobUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Upload reference is not a valid URL");
  }
  if (parsed.protocol !== "https:" || !/(^|\.)blob\.vercel-storage\.com$/i.test(parsed.hostname)) {
    throw new Error("Upload reference must point at Blob storage");
  }
}

export async function registerLibraryDocuments(
  category: string | null,
  nameOverride: string | null,
  files: UploadedFileMeta[]
) {
  const user = await requirePermission("library.manage");
  for (const file of files) assertBlobUrl(file.url);
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
  assertBlobUrl(file.url);
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
