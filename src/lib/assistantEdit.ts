import "server-only";
import { prisma } from "./db";
import { PLAN_KIND } from "./assistantPlan";

/**
 * EDIT AND RE-ASK (Sean, 2026-11-13: "I found no way to edit your last question and ask again").
 *
 * Asking again with `replaces` set takes the person's LAST question out before the new one is asked:
 *  - the exchange is deleted, so DAX reads the corrected question with the context before it — never the wrong
 *    question it replaces (recent turns are its conversation memory);
 *  - the PLANS that answer offered are closed, so none can be confirmed from an answer that no longer exists.
 *
 * WHAT AN ANSWER LEAVES FOR CONFIRM, AND HOW IT IS FOUND (review of #1092). In the CRM chat a task card lives only
 * in the answer on the screen — its stored row is made when Confirm is pressed — so it leaves with the exchange. A
 * plan is the one thing stored at once; the answer records each plan it offered by id (AssistantTurn.proposed
 * planId), and exactly those are closed. Nothing is matched by time: a card saved from WhatsApp, or another answer's
 * plan, is never touched.
 *
 * Only the person's own, latest, CRM-chat question, in this workspace — otherwise "not-latest", and the caller asks
 * nothing (the old exchange would still be in DAX's context).
 */
export type Withdrawal = "withdrawn" | "not-latest";

export async function withdrawLastQuestion(tenantId: string, userId: string, turnId: string): Promise<Withdrawal> {
  // The latest in ITS conversation (assistantConversation) — the thread on the screen — not across all of them.
  const asked = await prisma.assistantTurn.findFirst({ where: { id: turnId, tenantId, userId, source: "chat" }, select: { conversationId: true } });
  if (!asked) return "not-latest";
  const [last] = await prisma.assistantTurn.findMany({
    where: { tenantId, userId, source: "chat", conversationId: asked.conversationId },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, proposed: true },
  });
  if (!last || last.id !== turnId) return "not-latest";
  const planIds = offeredPlanIds(last.proposed);
  // The callback form: the scoped client refuses an array transaction.
  await prisma.$transaction(async (tx) => {
    await tx.assistantTurn.deleteMany({ where: { id: last.id, tenantId, userId } });
    if (planIds.length) {
      await tx.assistantTask.updateMany({
        where: { id: { in: planIds }, tenantId, userId, kind: PLAN_KIND, status: "open" },
        data: { status: "closed", closedAt: new Date(), nextAction: null },
      });
    }
  });
  return "withdrawn";
}

/** The plans an answer offered, by id, from what it recorded (AssistantTurn.proposed). */
export function offeredPlanIds(proposed: unknown): string[] {
  if (!Array.isArray(proposed)) return [];
  return proposed.flatMap((p) =>
    p && typeof p === "object" && (p as { kind?: unknown }).kind === "plan" && typeof (p as { planId?: unknown }).planId === "string"
      ? [(p as { planId: string }).planId]
      : [],
  );
}
