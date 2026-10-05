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

async function isCustomerSigner(r: Recipient): Promise<boolean> {
  if (r.role !== "signer") return false;
  if (!r.email?.trim()) return true; // phone-only: staff always sign in with an email
  return (await ciExactIds("userEmail", r.email.trim(), { limit: 1 })).length === 0;
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

/** The customer's invitation went out: a draft quote is now sent. */
export async function mirrorQuoteSent({ tenantId, quoteId, requestId }: Mirror, recipient: Recipient): Promise<void> {
  if (!quoteId || !tenantId) return;
  try {
    if (!(await isCustomerSigner(recipient))) return;
    await whileRequestOpen(tenantId, quoteId, requestId, (tx) =>
      tx.quote.updateMany({
        where: { id: quoteId, tenantId, status: "draft", deletedAt: null, signedAt: null, supersededAt: null },
        data: { status: "sent" },
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
    if (!(await isCustomerSigner(recipient))) return;
    await whileRequestOpen(tenantId, quoteId, requestId, (tx) =>
      tx.quote.updateMany({ where: { id: quoteId, tenantId, viewedAt: null, deletedAt: null }, data: { viewedAt: new Date() } }),
    );
  } catch (error) {
    await logError("signing", "couldn't mark the quote viewed", error instanceof Error ? error.name : "unknown");
  }
}
