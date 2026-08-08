/**
 * ADVISORY ONLY. The DATABASE decides who owns a draft.
 *
 * `claimConversationDraft` in conversationDraftStore.ts makes the real decision
 * inside one conditional statement, because deciding here and writing afterwards
 * is a race two people hit routinely once autosave is involved. What is left in
 * this file is the same rule expressed for the CLIENT, so the reply box can show
 * "Thandi is replying" on first render without a round trip.
 *
 * The two cannot drift on the only value they share: the SQL derives its window
 * from DRAFT_COLLISION_WINDOW_MS below, and a test asserts it does not restate it.
 * If they ever disagree about an edge, the database wins and the UI corrects
 * itself on the next save.
 *
 * When does saving a reply draft collide with a colleague's?
 *
 * A shared inbox's characteristic failure is two people answering the same
 * customer at the same time, and finding out afterwards. One draft per
 * conversation with a named owner turns that into something detectable BEFORE
 * the second reply goes out.
 *
 * Pure and DB-free on purpose. The original shared-inbox Phase 2 buried this
 * comparison inside a server action, where the only way to check it was to read
 * it — and the window arithmetic (which side of `now`, strict or inclusive,
 * whose draft counts) is exactly the kind of rule that is wrong quietly.
 */

/** How long a colleague's draft blocks an overwrite. */
export const DRAFT_COLLISION_WINDOW_MS = 5 * 60 * 1000;

export type ExistingDraft = {
  ownerId: string;
  ownerName: string;
  updatedAt: Date;
};

export type DraftCollision = { ownerName: string; updatedAt: string };

/**
 * The collision to report, or null when the save may proceed.
 *
 * Three things make it safe to overwrite, and all of them matter:
 *  - there is no draft;
 *  - the draft is the actor's OWN (typing more of your own reply is not a
 *    collision, and treating it as one would lock you out of your own draft);
 *  - the draft is stale. Somebody who opened a thread an hour ago and wandered
 *    off must not hold it forever, or the inbox jams on abandoned drafts.
 */
export function draftCollision(
  existing: ExistingDraft | null | undefined,
  actorId: string,
  now: Date,
  windowMs: number = DRAFT_COLLISION_WINDOW_MS,
): DraftCollision | null {
  if (!existing) return null;
  if (existing.ownerId === actorId) return null;
  const age = now.getTime() - existing.updatedAt.getTime();
  // A draft saved in the FUTURE (clock skew between instances) is treated as
  // fresh rather than stale: a negative age must not read as "long abandoned"
  // and hand the thread to a second person.
  if (age >= windowMs) return null;
  return { ownerName: existing.ownerName, updatedAt: existing.updatedAt.toISOString() };
}
