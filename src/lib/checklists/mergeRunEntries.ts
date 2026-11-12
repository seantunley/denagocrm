/**
 * Two copies of the same checklist run — what the server last rendered, and what
 * this phone holds — made into one, step by step (Sean, 2026-11-12: "Carry on"
 * wiped the progress).
 *
 * The phone's copy wins where it has an answer: it is the newer edit. But a step
 * the phone still has as "not done" never hides one the server has answered — the
 * phone's copy may predate the last save. Photos: the larger count, and every
 * photo either copy knows.
 */
export type MergeableEntry = {
  id: string;
  status: string;
  photoCount: number;
  photos: Array<{ id: string; url: string }>;
};

export function mergeRunEntries<T extends MergeableEntry>(server: T[], device: T[]): T[] {
  const onServer = new Map(server.map((entry) => [entry.id, entry]));
  return device.map((mine) => {
    const theirs = onServer.get(mine.id);
    if (!theirs) return mine;
    const answer = mine.status === "pending" && theirs.status !== "pending" ? theirs : mine;
    const photos = [...theirs.photos, ...mine.photos.filter((photo) => !theirs.photos.some((p) => p.id === photo.id))];
    return { ...answer, photoCount: Math.max(theirs.photoCount, mine.photoCount, photos.length), photos };
  });
}
