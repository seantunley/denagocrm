import "server-only";
import { basePrisma } from "@/lib/db";
import { deleteFile, listActiveUploadBlobs } from "@/lib/storage";
import { ORPHAN_GRACE_MS, isPastGrace, parsePhotoPath } from "@/lib/photoOrphanRules";

export { ORPHAN_GRACE_MS, parsePhotoPath } from "@/lib/photoOrphanRules";

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
  const [document, inspection] = await Promise.all([
    basePrisma.document.findFirst({ where: { storedName: url, tenantId }, select: { id: true } }),
    basePrisma.jobCardInspectionItem.findFirst({ where: { photoStoredName: url, tenantId }, select: { id: true } }),
  ]);
  return Boolean(document || inspection);
}

export type OrphanSweep = { scanned: number; deleted: number; kept: number };

/**
 * Delete unclaimed staged photos older than the grace period.
 *
 * `now` and `shouldStop` are injected so the sweep is testable and so a cron
 * slice can stop cleanly at its deadline rather than being cut off mid-delete.
 */
export async function sweepOrphanPhotos(opts: {
  tenantId: string | null;
  now?: () => number;
  shouldStop?: () => boolean;
  graceMs?: number;
} = { tenantId: null }): Promise<OrphanSweep> {
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? ORPHAN_GRACE_MS;
  const prefix = opts.tenantId ? `uploads/${opts.tenantId}/` : "uploads/";
  const blobs = await listActiveUploadBlobs(prefix);

  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  for (const blob of blobs) {
    if (opts.shouldStop?.()) break;
    const parsed = parsePhotoPath(blob.pathname);
    if (!parsed) continue;
    // A tenant-scoped sweep must never reach past its own namespace, even if the
    // store returned something outside the prefix it was asked for.
    if (opts.tenantId && parsed.tenantId !== opts.tenantId) continue;
    scanned++;

    if (!isPastGrace(blob.uploadedAt, now(), graceMs)) {
      kept++;
      continue;
    }
    if (await isClaimed(blob.url, parsed.tenantId)) {
      kept++;
      continue;
    }
    await deleteFile(blob.url);
    deleted++;
  }
  return { scanned, deleted, kept };
}
