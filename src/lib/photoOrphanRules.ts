/**
 * The rules the orphan sweep decides by, with no database and no store.
 *
 * Deliberately NOT in photoOrphans.ts, which is "server-only" because it reaches
 * Prisma and Blob and therefore cannot be imported by a test. These decide what
 * may be DELETED, so they are the part that most needs to be executable in a
 * test rather than pattern-matched out of its own source.
 */

/** Only the direct-upload namespace. Legacy files live at other shapes. */
export const PHOTO_KINDS = ["delivery", "jobcard", "jobcard-checkout", "inspection"] as const;

/**
 * How long a staged object may go unclaimed.
 *
 * Generous on purpose: the gap between upload and register is normally seconds,
 * but a technician on a bad signal can be minutes, and deleting a photo out from
 * under an upload still in flight is far worse than paying to store it for a day.
 */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * `uploads/<tenantId>/<kind>/<recordId>/<file>` — the shape the uploader writes.
 *
 * Anything else returns null and is left alone. This store also holds legacy
 * pre-namespacing documents, backups and managed objects; a sweep that guessed
 * at those would delete a customer's paperwork.
 */
export function parsePhotoPath(pathname: string): { tenantId: string; kind: string; recordId: string } | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 5 || segments[0] !== "uploads") return null;
  const [, tenantId, kind, recordId] = segments;
  if (!PHOTO_KINDS.includes(kind as (typeof PHOTO_KINDS)[number])) return null;
  if (!tenantId || !recordId) return null;
  return { tenantId, kind, recordId };
}

/**
 * Is this object old enough to be considered abandoned?
 *
 * An object with no upload time is treated as NOT old enough. The store should
 * always give one, and guessing "old" for a missing timestamp would make a
 * store-side omission delete photos.
 */
export function isPastGrace(uploadedAt: Date | null, now: number, graceMs: number = ORPHAN_GRACE_MS): boolean {
  if (!uploadedAt) return false;
  return now - uploadedAt.getTime() >= graceMs;
}
