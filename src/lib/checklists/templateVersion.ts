import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * Claim the right to write this revision of a checklist template.
 *
 * ── WHY THIS IS ITS OWN FUNCTION ────────────────────────────────────────────
 *
 * A template save reads the template, works out which steps survive, whether the
 * items changed, and what the new revision should contain — and only then
 * writes. Everything after the read is computed FROM that read, so the write is
 * only correct if the row is still where the read left it.
 *
 * It was not checked, and two editors who had both loaded revision 1 could both
 * "succeed":
 *
 *   A  sets version 2, writes its items, creates revision 2 = A's items
 *   B  sets version 2 again, overwrites the items with B's, and its revision
 *      upsert found revision 2 already there and did nothing
 *
 * leaving the LIVE template holding B's items while the immutable revision 2
 * held A's. Runs stamped version 2 then displayed one checklist and synced
 * against a different set of authoritative questions — precisely what a revision
 * snapshot exists to make impossible.
 *
 * Naming the version in the predicate makes the loser fail rather than clobber:
 * at READ COMMITTED, Postgres re-reads the row under its write lock, so the
 * second transaction matches nothing and reports it.
 *
 * It lives here, rather than inline in the action, so the race can be PROVEN
 * against a real database — see scripts/test-checklist-template-concurrency.ts.
 * The same reasoning put conversationDraftStore.ts and platformAdminLock.ts in
 * lib: a bug that only exists between two statements cannot be shown by a test
 * that can only call one of them.
 */
export async function claimTemplateVersion(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    templateId: string;
    /** The version the save was computed against. */
    fromVersion: number;
    /** Whether the items changed, and so whether this save takes a new version. */
    bump: boolean;
    meta: {
      name: string;
      description: string | null;
      active: boolean;
      sortOrder: number;
    };
  },
): Promise<boolean> {
  // `updateMany` rather than `update`, so the tenant is named in the call itself
  // — a write that carries its own scope cannot be detached from the read that
  // justified it by a later edit. tests/tenantAccessRatchet.test.ts holds every
  // tenant-owned write to this shape.
  const claimed = await tx.checklistTemplate.updateMany({
    where: { id: input.templateId, tenantId: input.tenantId, version: input.fromVersion },
    data: {
      ...input.meta,
      ...(input.bump ? { version: input.fromVersion + 1 } : {}),
    },
  });
  // Exactly one, or nobody. A count of 0 means the row moved under us; anything
  // above 1 would mean the predicate does not identify a single template, which
  // is a different bug and equally not something to write through.
  return claimed.count === 1;
}
