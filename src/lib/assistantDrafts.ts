import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { DRAFT_TURNS, DRAFTS_KEPT, parseStoredDrafts, type StoredDraft } from "./assistantDraftRules";

/**
 * The drafts written in ONE conversation, oldest first — the last DRAFTS_KEPT (assistantDraftRules). This person's,
 * in this workspace, in this conversation only: never another user's drafts, nor another conversation's.
 */
export async function conversationDrafts(who: { tenantId: string; userId: string }, conversationId: string): Promise<StoredDraft[]> {
  const turns = await prisma.assistantTurn.findMany({
    where: { tenantId: who.tenantId, userId: who.userId, conversationId, drafts: { not: Prisma.DbNull } },
    orderBy: { createdAt: "desc" },
    take: DRAFT_TURNS,
    select: { drafts: true },
  });
  return turns.reverse().flatMap((t) => parseStoredDrafts(t.drafts)).slice(-DRAFTS_KEPT);
}
