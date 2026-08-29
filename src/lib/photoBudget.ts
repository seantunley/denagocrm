/**
 * How large a photo upload is allowed to be, and how far to shrink one.
 *
 * The numbers were incoherent. The upload actions accept 12 photos of up to 4 MB
 * each — 48 MB — while Next caps a Server Action request body at 1 MB by default
 * and `next.config.ts` set no limit. So a single ordinary phone photo was rejected
 * by the framework before `uploadJobCardPhotos` saw it, and its careful per-file
 * validation never ran. The camera button worked in review and would not have
 * worked on a phone.
 *
 * Two halves of the fix, and both are needed: the request limit is now declared
 * (see next.config.ts) and the client SHRINKS images before they are sent, so the
 * declared limit is one real uploads stay under rather than one they scrape past.
 *
 * Pure and DOM-free, so the arithmetic is testable without a browser.
 */

/**
 * Longest edge a stored photo needs. A job-card condition photo is evidence of a
 * scratch, not a print — 1600px is more than a reviewer can use on a screen, and
 * a modern phone's 4000px original costs about six times the bytes to say it.
 */
export const PHOTO_MAX_EDGE = 1600;

/** JPEG quality for re-encoded photos. Visually lossless for this purpose. */
export const PHOTO_JPEG_QUALITY = 0.82;

/**
 * Most photos accepted per batch, by the direct uploader and the legacy upload
 * actions alike. Direct uploads send one file per request, so raising the count
 * does not grow any single HTTP body — the limit is about how much a person can
 * usefully queue at once, not about the request size ceiling.
 *
 * Kept as a literal that MAX_PHOTOS derives from, rather than the other way
 * round, so the config-contract test has one number to assert against.
 */
export const DIRECT_PHOTO_BATCH_LIMIT = 12;

/** Legacy upload actions use the same application-wide count. */
export const MAX_PHOTOS = DIRECT_PHOTO_BATCH_LIMIT;

/** Largest single file, after shrinking. */
export const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/**
 * Largest TOTAL request payload the server will accept.
 *
 * Deliberately below the declared bodySizeLimit: the request also carries form
 * fields, boundaries and the action's own encoding, so a total equal to the limit
 * would be rejected by the framework and the person would see a generic failure
 * instead of this module's explanation.
 */
export const MAX_UPLOAD_TOTAL_BYTES = 14 * 1024 * 1024;

/** The limit declared to Next. MAX_UPLOAD_TOTAL_BYTES must stay under it. */
export const SERVER_ACTION_BODY_LIMIT = "16mb";

/**
 * Target dimensions for one image, preserving aspect ratio.
 *
 * Never scales UP: a small photo re-encoded larger would gain bytes and no
 * detail, which is the opposite of the point.
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number = PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  // Rounded, and floored at 1: a very thin image scaled down could otherwise
  // round a dimension to 0 and produce a canvas that cannot be drawn.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type PayloadVerdict =
  | { ok: true; total: number }
  | { ok: false; total: number; reason: string };

/**
 * Is this set of files sendable?
 *
 * Answered BEFORE the request goes out, because the alternative is the framework
 * rejecting it and the person seeing a failure with no reason in it. Reported in
 * megabytes because that is the unit a phone's gallery shows.
 */
export function checkUploadPayload(
  sizes: number[],
  limits: { maxPhotos?: number; maxPerFile?: number; maxTotal?: number } = {},
): PayloadVerdict {
  const maxPhotos = limits.maxPhotos ?? MAX_PHOTOS;
  const maxPerFile = limits.maxPerFile ?? MAX_PHOTO_BYTES;
  const maxTotal = limits.maxTotal ?? MAX_UPLOAD_TOTAL_BYTES;
  const total = sizes.reduce((sum, size) => sum + size, 0);

  if (sizes.length > maxPhotos) {
    return { ok: false, total, reason: `Attach up to ${maxPhotos} photos at a time.` };
  }
  const oversize = sizes.filter((size) => size > maxPerFile).length;
  if (oversize > 0) {
    return {
      ok: false,
      total,
      reason: `${oversize === 1 ? "One photo is" : `${oversize} photos are`} over ${mb(maxPerFile)} even after resizing.`,
    };
  }
  if (total > maxTotal) {
    return {
      ok: false,
      total,
      reason: `These photos total ${mb(total)}, over the ${mb(maxTotal)} limit. Send them in two batches.`,
    };
  }
  return { ok: true, total };
}

function mb(bytes: number): string {
  const value = bytes / (1024 * 1024);
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} MB`;
}
