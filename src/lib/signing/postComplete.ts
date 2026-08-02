import "server-only";
import { prisma } from "@/lib/db";
import { payableTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { formatZAR } from "@/lib/format";
import { markReferralEarned } from "@/lib/referrals";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";

/**
 * Fire the EXTERNAL side-effects of a signed document once the hub has completed
 * a request. The CORE state — request completed, sealed PDF filed, and the source
 * quote/job card marked signed — is now committed atomically inside
 * completeSignatureRequest's transaction. This function only fans out the
 * non-transactional effects (referral, automations, push, audit) and is
 * best-effort: a failure here must never unwind an already-completed request.
 *
 * It runs only when the completion transaction actually signed the source
 * (`sourceSigned`), so a source already signed elsewhere / trashed / superseded
 * doesn't re-fire won-effects. `wonLeadId` is set only when that same
 * transaction won the lead, keeping lead effects in step with the quote.
 */

type CompletedReq = {
  id: string;
  title: string;
  quoteId: string | null;
  jobCardId: string | null;
  signedByName: string | null;
  signedPdfHash: string | null;
  signedDocId: string | null;
  sourceSigned: boolean;
  wonLeadId: string | null;
};

export async function runPostCompletion(req: CompletedReq): Promise<void> {
  if (!req.sourceSigned) return; // source wasn't newly signed — nothing to fan out
  try {
    if (req.quoteId) await afterQuoteSigned(req);
    else if (req.jobCardId) await afterJobCardSigned(req);
  } catch (err) {
    // Never fail completion because a downstream effect threw.
    console.error("[signing] post-completion side-effects failed", err);
  }
}

async function afterQuoteSigned(req: CompletedReq): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: req.quoteId! },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
  });
  if (!quote) return;
  const name = req.signedByName || "Customer";
  // What was actually signed for — fees included, matching the document.
  const total = payableTotalCents(quote);

  if (req.wonLeadId) {
    await markReferralEarned(req.wonLeadId).catch(() => {});
    // Keyed on the signature request, not the lead's updatedAt: the win was
    // committed inside completeSignatureRequest's transaction, which this
    // function only fans out from, so the lead row may have been touched since.
    await emitLeadJourneyEvent("lead_won", req.wonLeadId, {
      occurrence: `signature-request:${req.id}`,
      payload: { signatureRequestId: req.id, quoteId: req.quoteId },
    });
  }
  await logAudit({
    action: "quote.signed",
    summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) signed online by ${name} via signing hub — sealed PDF filed${req.signedPdfHash ? ` (SHA-256 ${req.signedPdfHash.slice(0, 16)}…)` : ""}`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    userName: name,
  });
  // A quote is signed once, so the quote id alone is the occurrence.
  if (quote.leadId) {
    await emitLeadJourneyEvent("quote_signed", quote.leadId, {
      occurrence: `quote:${quote.id}:signed`,
      payload: { quoteId: quote.id, quoteNumber: quote.number, signatureRequestId: req.id },
    });
  }
  await sendPushToAll(
    { title: "Quote signed 🎉", body: `Q-${quote.number} — ${name} · ${formatZAR(Math.round(total))}`, url: `/quotes/${quote.id}` },
    "quote_signed"
  ).catch(() => {});
}

async function afterJobCardSigned(req: CompletedReq): Promise<void> {
  const jobCard = await prisma.jobCard.findUnique({ where: { id: req.jobCardId! } });
  if (!jobCard) return;
  const name = req.signedByName || "Customer";
  await logAudit({
    action: "jobcard.signed",
    summary: `Job card #${jobCard.number} signed online by ${name} via signing hub — sealed PDF filed`,
    contactId: jobCard.contactId,
    userName: name,
  });
  await sendPushToAll(
    { title: "Job card signed ✍", body: `#${jobCard.number} — ${name}`, url: `/jobcards/${jobCard.id}` },
    "quote_signed"
  ).catch(() => {});
}
