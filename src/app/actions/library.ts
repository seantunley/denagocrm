"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { withActingTenantWrite } from "@/lib/actingScope";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { softDeleteRecord } from "@/lib/trash";
import { MAX_BLOB_BYTES, assertOwnedBlob } from "@/lib/storage";
import { actingScopeClass } from "@/lib/actingScope";

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
  // "Ours" is not "yours". The store is ONE store shared by every workspace, so
  // proving the object is in it says nothing about who owns it: a library manager
  // in workspace B who has come by a blob URL from workspace A — a forwarded
  // email, a pasted link, browser history — could register A's file into B's
  // library and then download it through B's own authorised route. The expected
  // owner turns the store's pathname into an ownership check.
  const scope = await actingScopeClass();
  // No founding-tenant fallback. `global` is a session that could not be
  // resolved to a workspace, and defaulting to DEFAULT_TENANT_ID pointed the
  // ownership check at the FOUNDING tenant's namespace — so a caller in that
  // state was refused their own workspace's blobs and accepted the founding
  // tenant's, which is the opposite of what this check exists to do.
  if (scope.mode !== "tenant") {
    throw new Error("No workspace is attached to this sign-in — sign out and back in to add library files.");
  }
  const expectedTenantId = scope.tenantId;
  const owned = await assertOwnedBlob(file.url, expectedTenantId);
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
    //
    // USER-ORIGINATED: `requirePermission("library.manage")` above proves a
    // signed-in person is doing this, and the document is NEW — it has no parent to
    // inherit from, so the uploader's workspace is the owner. `withTenantWrite`
    // resolved `writeTenantId() ?? DEFAULT_TENANT_ID` and `writeTenantId()` is null
    // while enforcement is dormant, so a second workspace's brochures and price
    // lists were filed under the founding tenant. The VERSION takes the same
    // tenantId as the document created beside it in this transaction, so the
    // composite FK holds by construction.
    await withActingTenantWrite(async (tx, tenantId) => {
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
  //
  // USER-ORIGINATED, WITH A PARENT. A version is a CHILD of the document, so it
  // inherits the DOCUMENT's tenant, not the uploader's. That distinction is the
  // #470 contact-tags invariant and it is load-bearing here: an owner with access
  // to another workspace's document who uploads a revision must not re-own the
  // revision away from the document that holds it. LibraryDocument carries
  // `@@unique([tenantId, id])` precisely so `(tenantId, documentId)` can become a
  // composite FK — a version whose tenant disagrees with its document breaks that
  // FK at the enforcement flip, and until then simply hides the newest revision
  // from the workspace that owns the document.
  //
  // `?? actingTenantId` covers the legacy row: LibraryDocument.tenantId is still
  // nullable and nothing stamped it before this window, so an un-owned parent
  // falls back to the acting workspace rather than writing a tenantless child.
  await withActingTenantWrite(async (tx, actingTenantId) => {
    const tenantId = document.tenantId ?? actingTenantId;
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
  // Nothing matched — another tenant's id, or already gone. Never audit a
  // deletion that did not happen.
  if (!document) return;
  await logAudit({
    action: "trash.deleted",
    summary: `Moved library document “${document.name}” to trash — ${reason}`,
    user,
  });
  revalidatePath("/library");
}
