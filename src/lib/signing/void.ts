import "server-only";
import { prisma, basePrisma } from "@/lib/db";
import { CLOSED_REQUEST_STATUSES } from "./status";

/**
 * Withdraw an open signing request — ONE definition, for every Void button.
 *
 * There were two. The card on the quote voided the request and put a sent quote
 * back to Draft in one transaction. The Void on the Signatures page only voided
 * the request, so the quote went on saying "Sent" about a document nobody could
 * sign any more, and stayed out of every list of quotes still to be sent.
 *
 * The caller has already decided this person may void this request. What is
 * decided here is whether it can still be voided, and what goes back with it.
 *
 * Returns the record it belonged to when THIS call voided it, and null when
 * there was nothing open to void — already completed, declined, expired,
 * rejected or voided by somebody else a moment earlier.
 */
export async function voidOpenRequest(
  requestId: string,
): Promise<{ quoteId: string | null; jobCardId: string | null; tenantId: string } | null> {
  // Through the guarded client: a request outside the caller's workspace is not
  // there to be voided. Its own tenant is then named on every statement below,
  // because the transaction runs on the RLS bypass.
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    select: { tenantId: true, quoteId: true, jobCardId: true },
  });
  if (!request?.tenantId) return null;
  const { tenantId, quoteId, jobCardId } = request;

  const voided = await basePrisma.$transaction(async (tx) => {
    // Universal lock order — SOURCE record first, THEN the request (matching
    // completion / deletion / start) so a void cannot deadlock against a
    // concurrent completion.
    if (quoteId) await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    else if (jobCardId) await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${jobCardId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    // CONDITIONAL — only an open request. An unconditional update would overwrite
    // one a signer just completed or declined, discarding that final state.
    const result = await tx.signatureRequest.updateMany({
      where: { id: requestId, tenantId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
      data: { status: "voided" },
    });
    if (result.count === 0) return false;
    // Nothing is out any more, so a quote this had marked sent is a draft again.
    if (quoteId) {
      await tx.quote.updateMany({ where: { id: quoteId, tenantId, status: "sent", signedAt: null }, data: { status: "draft" } });
    }
    return true;
  });
  return voided ? { quoteId, jobCardId, tenantId } : null;
}
