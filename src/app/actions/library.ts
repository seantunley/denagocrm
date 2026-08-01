"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withTenantWrite } from "@/lib/tenantWrite";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { MAX_BLOB_BYTES, assertOwnedBlob } from "@/lib/storage";

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

/**
 * Resolve the upload through OUR Blob store and take the metadata FROM THE
 * STORE.
 *
 * The hostname check above proves the vendor, not the owner —
 * `*.blob.vercel-storage.com` is every Vercel customer's store. And `sizeBytes`
 * and `mimeType` arrived from the browser alongside the URL, so a library
 * manager could register a stranger's object, declare it 1 KB of text/plain, and
 * have the server fetch whatever it actually was on the next download.
 *
 * assertOwnedBlob answers both: an object outside our store is a miss, and the
 * size and content type it returns are the store's numbers, not the caller's.
 */
async function resolveUpload(file: UploadedFileMeta) {
  assertBlobUrl(file.url);
  const owned = await assertOwnedBlob(file.url);
  if (owned.size > MAX_BLOB_BYTES) {
    throw new Error(`That file is too large to store (limit ${Math.floor(MAX_BLOB_BYTES / (1024 * 1024))} MB).`);
  }
  return {
    sizeBytes: owned.size,
    mimeType: owned.contentType || file.mimeType || "application/octet-stream",
  };
}

export async function registerLibraryDocuments(
  category: string | null,
  nameOverride: string | null,
  files: UploadedFileMeta[]
) {
  const user = await requirePermission("library.manage");
  if (files.length === 0) return;
  // Resolve every upload through our own store BEFORE writing any of them, so a
  // batch containing one foreign URL registers nothing rather than half of it.
  const resolved = await Promise.all(files.map(resolveUpload));
  const added: string[] = [];
  for (const [index, file] of files.entries()) {
    const meta = resolved[index];
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
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes,
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
  const meta = await resolveUpload(file);
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
        mimeType: meta.mimeType,
        sizeBytes: meta.sizeBytes,
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
