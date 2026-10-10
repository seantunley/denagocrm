import "server-only";
import { prisma } from "@/lib/db";
import { endOfCalendarDay } from "@/lib/quoteExpiry";
import { buildSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES } from "./status";

/**
 * A signing link stops working when its quote does (Sean, 2026-10-09).
 *
 * Starting or sending a signing request was already refused once a quote had
 * expired — but a link that had gone out kept working for good, because nothing
 * ever set SignatureRequest.expiresAt. A customer could open a three-week-old
 * email and accept the old price, and the quote was marked accepted and the
 * lead won. The signing routes have always refused a request past its
 * `expiresAt`; this is what finally gives that column a value.
 *
 * Requests created before this carry no expiry and are deliberately left alone:
 * closing a link that is already in a customer's inbox is a decision for the
 * person who sent it, not for a deploy.
 */

/** When a quote's signing link stops working: the end of its valid-until day on the workspace calendar. */
export function quoteLinkExpiry(validUntil: Date | null, timeZone: string): Date | null {
  return validUntil ? endOfCalendarDay(validUntil, timeZone) : null;
}

const MAX_PER_RUN = 50;

/**
 * Close every open request whose expiry has passed, for ONE named tenant.
 *
 * The routes refuse an expired link on their own; this makes the rest of the
 * CRM agree. Until the status says "expired" the request still counts as open:
 * it keeps the quote locked for editing, sits under In progress on Signatures,
 * and the card on the quote offers to resend a link that cannot be used.
 *
 * A request everyone has already signed is never expired — that is a completion
 * in flight (or one that needs a person), and it has its own recovery.
 */
export async function expireOverdueSigningRequests(tenantId: string, now: Date = new Date()): Promise<number> {
  const overdue = await prisma.signatureRequest.findMany({
    where: { tenantId, deletedAt: null, expiresAt: { lt: now }, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    select: { id: true, quoteId: true, jobCardId: true, expiresAt: true },
    orderBy: { expiresAt: "asc" },
    take: MAX_PER_RUN,
  });
  let expired = 0;
  for (const request of overdue) {
    const closed = await prisma.$transaction(async (tx) => {
      // Universal lock order — SOURCE record first, THEN the request — the one
      // completion, voiding, declining and signing start all keep.
      if (request.quoteId) await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${request.quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      else if (request.jobCardId) await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${request.jobCardId} AND "tenantId" = ${tenantId} FOR UPDATE`;
      await tx.$executeRaw`SELECT id FROM "SignatureRequest" WHERE id = ${request.id} AND "tenantId" = ${tenantId} FOR UPDATE`;
      // Under the request's lock, which the signing route also takes: a last
      // signature that landed a moment before midnight has either committed
      // (and is counted here) or will be refused as expired — never both.
      const signers = await tx.signatureRecipient.findMany({
        where: { requestId: request.id, tenantId, role: { not: "viewer" } },
        select: { status: true },
      });
      if (signers.length > 0 && signers.every((signer) => signer.status === "signed")) return false;
      const claimed = await tx.signatureRequest.updateMany({
        where: { id: request.id, tenantId, deletedAt: null, expiresAt: { lt: now }, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
        data: { status: "expired" },
      });
      if (claimed.count !== 1) return false;
      await tx.signatureEvent.create({
        data: buildSignEvent(request.id, {
          type: "expired",
          actor: "system",
          metadata: { expiresAt: request.expiresAt?.toISOString() ?? null },
        }),
      });
      // The request's status trigger revokes every signing link in this commit.
      return true;
    });
    if (closed) expired += 1;
  }
  return expired;
}
