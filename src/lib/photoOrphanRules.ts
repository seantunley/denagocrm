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

export type OrphanSweep = {
  scanned: number;
  deleted: number;
  kept: number;
  /** True when the pass reached the end of the namespace and reset the cursor. */
  completed: boolean;
};

export type SweepIo = {
  listPage: (prefix: string, cursor?: string | null) => Promise<{ blobs: Array<{ pathname: string; url: string; uploadedAt: Date | null }>; cursor: string | null }>;
  claimed: (url: string, tenantId: string) => Promise<boolean>;
  remove: (url: string) => Promise<void>;
  readCursor: (key: string) => Promise<string | null>;
  writeCursor: (key: string, value: string) => Promise<void>;
};

/**
 * Where the last tick stopped.
 *
 * WITHOUT THIS THE SWEEP STARVES ITS OWN TAIL. It runs on a cron budget, so a
 * version that always began at the first object spent every tick re-examining
 * the same head of the namespace; as storage grew, objects past what one tick
 * could reach would never be considered at all — and those are precisely the
 * oldest, most certainly abandoned ones. The cursor is cleared when a pass
 * completes, so the next pass starts fresh rather than drifting forever.
 */
export const CURSOR_KEY = "PHOTO_ORPHAN_SWEEP_CURSOR";
export const cursorKeyFor = (tenantId: string | null) => (tenantId ? `${CURSOR_KEY}:${tenantId}` : CURSOR_KEY);

/**
 * The sweep loop, with every effect injected.
 *
 * Lives here rather than in photoOrphans.ts because that module is "server-only"
 * and cannot be imported by a test. The resume behaviour is the part that was
 * wrong, so it is the part that most needs to be executable.
 */
export async function runOrphanSweep(opts: {
  tenantId: string | null;
  io: SweepIo;
  now?: () => number;
  shouldStop?: () => boolean;
  graceMs?: number;
}): Promise<OrphanSweep> {
  const now = opts.now ?? Date.now;
  const graceMs = opts.graceMs ?? ORPHAN_GRACE_MS;
  const { io } = opts;
  const prefix = opts.tenantId ? `uploads/${opts.tenantId}/` : "uploads/";
  const key = cursorKeyFor(opts.tenantId);

  let cursor = (await io.readCursor(key)) || null;
  let scanned = 0;
  let deleted = 0;
  let kept = 0;
  let completed = false;

  for (;;) {
    // Checked BEFORE the fetch. A page listed and then abandoned is budget spent
    // for nothing, and the work would be repeated next tick anyway.
    if (opts.shouldStop?.()) break;

    const page = await io.listPage(prefix, cursor);
    let stoppedMidPage = false;

    for (const blob of page.blobs) {
      if (opts.shouldStop?.()) { stoppedMidPage = true; break; }
      const parsed = parsePhotoPath(blob.pathname);
      if (!parsed) continue;
      // A tenant-scoped sweep must never reach past its own namespace, even if
      // the store returned something outside the prefix it was asked for.
      if (opts.tenantId && parsed.tenantId !== opts.tenantId) continue;
      scanned++;

      if (!isPastGrace(blob.uploadedAt, now(), graceMs)) { kept++; continue; }
      if (await io.claimed(blob.url, parsed.tenantId)) { kept++; continue; }
      await io.remove(blob.url);
      deleted++;
    }

    /*
     * ADVANCE EVEN WHEN CUT SHORT. Resuming at the same page looks kinder — no
     * object is skipped — but it is how the sweep starves its own tail: a page
     * whose photos are all legitimately CLAIMED is not shortened by a tick's
     * work, so a budget that runs out inside it would re-examine that same page
     * every night and never reach anything after it. Moving on guarantees
     * forward progress; the remainder of this page is picked up on the next
     * pass, which for a 24-hour grace period costs an orphan one more day.
     */
    cursor = page.cursor;
    if (!cursor) { completed = true; break; }
    if (stoppedMidPage) break;
  }

  // An empty string clears the cursor, so the next pass starts fresh. No
  // `completed ? …` branch is needed and one would be dead code: reaching the end
  // is precisely the case where the store handed back a null cursor, so the two
  // arms are the same value. (Mutation testing found that, by "changing" it and
  // nothing failing.)
  await io.writeCursor(key, cursor ?? "");
  return { scanned, deleted, kept, completed };
}
