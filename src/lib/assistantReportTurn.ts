import "server-only";
import { prisma } from "./db";

/**
 * The answer a DAX report PDF is made from: the person's OWN, in the workspace they are acting in NOW.
 *
 * Review of #1093: looked up by id and user only, an answer given in workspace A could be fetched while acting in
 * workspace B — and printed under B's name and logo — whenever tenant enforcement is not filtering the query
 * (dormant, or a rollback). The workspace is named here, so that can't happen whatever enforcement is doing.
 * Someone else's answer, another workspace's, or a missing one all come back the same: null.
 */
export async function findReportTurn(tenantId: string, userId: string, turnId: string) {
  return prisma.assistantTurn.findFirst({
    where: { id: turnId, userId, tenantId },
    select: { question: true, answer: true, createdAt: true },
  });
}
