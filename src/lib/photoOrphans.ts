import "server-only";
import { basePrisma } from "@/lib/db";
import { deleteFile, listActiveUploadBlobPage } from "@/lib/storage";
import { getSetting, putSetting } from "@/lib/settings";
import { runOrphanSweep, type OrphanSweep } from "@/lib/photoOrphanRules";

export { ORPHAN_GRACE_MS, parsePhotoPath } from "@/lib/photoOrphanRules";
export type { OrphanSweep } from "@/lib/photoOrphanRules";

/**
 * Sweep staged photos that never became records.
 *
 * A direct upload is two steps that a phone can fall between: the browser sends
 * the file to Blob storage, and THEN calls register*Photos to file it. Close the
 * PWA, lose signal, or lock the screen in between and the object is already in
 * the store with nothing pointing at it. Nothing recovers it — the completion
 * callback records no rows, and the register action never ran — so it is billed
 * storage that no screen can show and no delete button can reach.
 *
 * The old FormData path could not produce these: it wrote the file and the
 * Document row in the same request, and rolled the file back if the row failed.
 * Direct upload trades that atomicity for a request small enough to survive a
 * phone, which is the right trade — but it makes cleanup a background job rather
 * than a `catch`.
 *
 * This module is only the WIRING. The loop, including the paging and resume
 * behaviour, lives in photoOrphanRules.ts so it can be exercised without a Blob
 * store or a database.
 */

/**
 * Is this staged object claimed by a record?
 *
 * Checked against BOTH places a photo URL can be stored — Document.storedName for
 * delivery and job-card photos, JobCardInspectionItem.photoStoredName for
 * inspection items. Missing the second would delete every inspection photo ever
 * taken, so the two are asserted together in the tests rather than left implicit.
 *
 * Scoped to the tenant NAMED IN THE OBJECT PATH, not asked globally. The blob
 * lives at uploads/<tenantId>/..., so that workspace is the only one that can
 * legitimately claim it — assertOwnedBlob refuses cross-tenant filing, so a
 * claim from anywhere else is not a claim. It also keeps this basePrisma read
 * inside the tenant ratchet rather than reaching across every workspace.
 */
async function isClaimed(url: string, tenantId: string): Promise<boolean> {
  // Matched on the object's PATH, not its full URL. The same file has a
  // different host in the public and private stores, and the private-store
  // migration keeps paths — so a record still holding the public link claims
  // the private copy. Equality on the URL would have let the sweep delete every
  // migrated photo whose record had not been repointed.
  const claim = { endsWith: `/${new URL(url).pathname.replace(/^\/+/, "")}` };
  const [document, inspection] = await Promise.all([
    basePrisma.document.findFirst({ where: { storedName: claim, tenantId }, select: { id: true } }),
    basePrisma.jobCardInspectionItem.findFirst({ where: { photoStoredName: claim, tenantId }, select: { id: true } }),
  ]);
  return Boolean(document || inspection);
}

/** Delete unclaimed staged photos older than the grace period, within budget. */
export async function sweepOrphanPhotos(opts: {
  tenantId: string | null;
  now?: () => number;
  shouldStop?: () => boolean;
  graceMs?: number;
} = { tenantId: null }): Promise<OrphanSweep> {
  return runOrphanSweep({
    ...opts,
    io: {
      listPage: listActiveUploadBlobPage,
      claimed: isClaimed,
      remove: deleteFile,
      readCursor: getSetting,
      writeCursor: putSetting,
    },
  });
}
