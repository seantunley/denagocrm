import "server-only";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { ciExactIds } from "@/lib/ciExact";
import { CLOSED_REQUEST_STATUSES } from "./status";

/**
 * A quote sent from the signing hub HAS been sent, and opened when the customer
 * opens it — but the hub recorded that only on its own request, so the quote
 * itself stayed "draft" and never viewed. Everything that reads the quote (the
 * gone-quiet nudge, lead score, attention list, dashboard, DAX) then said
 * "not sent" about a quote the customer had open (production, Q-1022, Oct 2026).
 * Emailing a quote already marks it sent (quoteEmail markSentIfDraft); voiding a
 * hub request already puts it back to draft. This is the missing middle.
 *
 * Only for the CUSTOMER: a signer (not an approver or viewer) who isn't a staff
 * member — an internal countersigner reaching the quote isn't the customer
 * receiving it. These run from the public signing page and from cron as well as
 * from staff actions, so every statement names the request's own tenant.
 */
type Recipient = { role: string; email: string | null };
type Tx = Parameters<Parameters<typeof basePrisma.$transaction>[0]>[0];

/**
 * Staff of THIS workspace only. An address that belongs to a user in another
 * workspace is still this workspace's customer — and a global "is anyone a user
 * with this email?" would also answer, across workspaces, who is a member where.
 * Exact, case-folded email (ciExactIds), then membership of the request's tenant.
 */
export async function isCustomerSigner(r: Recipient, tenantId: string): Promise<boolean> {
  if (r.role !== "signer") return false;
  const email = r.email?.trim();
  if (!email) return true; // phone-only: staff always sign in with an email
  const userIds = await ciExactIds("userEmail", email);
  if (!userIds.length) return true;
  const member = await basePrisma.tenantMember.findFirst({ where: { tenantId, userId: { in: userIds } }, select: { userId: true } });
  return !member;
}

/**
 * Same lock order as voiding (quote FIRST, then the request): a void landing
 * while the invitation was going out has already put the quote back to draft
 * and closed the request, so this finds the request closed and changes nothing.
 */
async function whileRequestOpen(tenantId: string, quoteId: string, requestId: string, write: (tx: Tx) => Promise<unknown>) {
  await basePrisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    const open = await tx.signatureRequest.findFirst({
      where: { id: requestId, tenantId, quoteId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
      select: { id: true },
    });
    if (open) await write(tx);
  });
}

type Mirror = { tenantId: string | null; quoteId: string | null; requestId: string };

/**
 * The customer's invitation went out: the quote is now sent.
 *
 * From draft, and from DECLINED too. A quote the customer turned down and was
 * then sent again is out for signature, not declined — left as it was, every
 * reader of the quote (the gone-quiet nudge, the attention list, DAX) went on
 * saying "declined" about a document sitting in the customer's inbox. The old
 * answer is cleared with it; it stays on the request that was declined and in
 * the audit trail.
 */
export async function mirrorQuoteSent({ tenantId, quoteId, requestId }: Mirror, recipient: Recipient): Promise<void> {
  if (!quoteId || !tenantId) return;
  try {
    if (!(await isCustomerSigner(recipient, tenantId))) return;
    await whileRequestOpen(tenantId, quoteId, requestId, (tx) =>
      tx.quote.updateMany({
        where: { id: quoteId, tenantId, status: { in: ["draft", "declined"] }, deletedAt: null, signedAt: null, supersededAt: null },
        data: { status: "sent", declinedAt: null, declineReason: null },
      }),
    );
  } catch (error) {
    // Never at the cost of the send itself.
    await logError("signing", "couldn't mark the quote sent", error instanceof Error ? error.name : "unknown");
  }
}

/** The customer opened it: the quote's first-viewed time, if it has none yet. */
export async function mirrorQuoteViewed({ tenantId, quoteId, requestId }: Mirror, recipient: Recipient): Promise<void> {
  if (!quoteId || !tenantId) return;
  try {
    if (!(await isCustomerSigner(recipient, tenantId))) return;
    await whileRequestOpen(tenantId, quoteId, requestId, (tx) =>
      tx.quote.updateMany({ where: { id: quoteId, tenantId, viewedAt: null, deletedAt: null }, data: { viewedAt: new Date() } }),
    );
  } catch (error) {
    await logError("signing", "couldn't mark the quote viewed", error instanceof Error ? error.name : "unknown");
  }
}
