import "server-only";
import { prisma } from "./db";

/**
 * EDIT AND RE-ASK (Sean, 2026-11-13: "I found no way to edit your last question and ask again").
 *
 * Asking again with `replaces` set takes the person's LAST question out before the new one is asked:
 *  - the exchange is deleted, so DAX reads the corrected question with the context before it — never the wrong
 *    question it replaces (recent turns are its conversation memory);
 *  - anything that answer set up and is still waiting for Confirm (the stored confirm-key and plan rows) is
 *    withdrawn, so nothing can be confirmed from an answer that no longer exists.
 * Only the person's own, latest, CRM-chat question, in this workspace. Anything else is refused and the new
 * question is simply asked as a new one.
 */
export async function withdrawLastQuestion(tenantId: string, userId: string, turnId: string): Promise<boolean> {
  const latest = await prisma.assistantTurn.findMany({
    where: { tenantId, userId, source: "chat" },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true, createdAt: true },
  });
  const [last, before] = latest;
  if (!last || last.id !== turnId) return false;
  const now = new Date();
  // The callback form: the scoped client refuses an array transaction.
  await prisma.$transaction(async (tx) => {
    await tx.assistantTurn.deleteMany({ where: { id: last.id, tenantId, userId } });
    // What this answer set up: rows made after the question before it, up to when this answer was saved.
    await tx.assistantPendingAction.updateMany({
      where: {
        tenantId,
        userId,
        confirmedAt: null,
        completedAt: null,
        failedAt: null,
        expiresAt: { gt: now },
        createdAt: { gt: before?.createdAt ?? new Date(last.createdAt.getTime() - 30 * 60_000), lte: new Date(last.createdAt.getTime() + 5_000) },
      },
      data: { expiresAt: now },
    });
  });
  return true;
}
