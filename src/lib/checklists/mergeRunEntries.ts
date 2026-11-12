/**
 * Two copies of the same checklist run — what the server last rendered, and what
 * this phone holds — made into one, step by step (Sean, 2026-11-12: "Carry on"
 * wiped the progress).
 *
 * The phone's copy wins where it has an answer: it is the newer edit. But a step
 * the phone still has as "not done" never hides one the server has answered — the
 * phone's copy may predate the last save. Photos: every photo either copy knows,
 * EXCEPT one this phone deleted (`removedPhotoIds`) — an older server copy still
 * lists it, and bringing it back would count evidence that is gone and could
 * block a replacement at the step's limit (review of #1074). The count is the
 * photos that remain.
 */
export type MergeableEntry = {
  id: string;
  status: string;
  photoCount: number;
  photos: Array<{ id: string; url: string }>;
  /** Photos deleted on this phone, so an older copy that still lists them doesn't bring them back. */
  removedPhotoIds?: string[];
};

export function mergeRunEntries<T extends MergeableEntry>(server: T[], device: T[]): T[] {
  const onServer = new Map(server.map((entry) => [entry.id, entry]));
  return device.map((mine) => {
    const theirs = onServer.get(mine.id);
    if (!theirs) return mine;
    const answer = mine.status === "pending" && theirs.status !== "pending" ? theirs : mine;
    const removed = [...new Set([...(theirs.removedPhotoIds ?? []), ...(mine.removedPhotoIds ?? [])])];
    const photos = [...theirs.photos, ...mine.photos.filter((photo) => !theirs.photos.some((p) => p.id === photo.id))]
      .filter((photo) => !removed.includes(photo.id));
    return { ...answer, photoCount: photos.length, photos, removedPhotoIds: removed };
  });
}
