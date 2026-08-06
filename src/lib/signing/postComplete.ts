import "server-only";
import { prisma } from "@/lib/db";
import { payableTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { formatZAR } from "@/lib/format";
import { markReferralEarned } from "@/lib/referrals";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";

export type CompletedReq = {
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

/**
 * Durable post-completion effects. This function intentionally does not swallow
 * operational failures: the transactional outbox retries the job with backoff
 * and exposes dead letters. Individual effects use stable occurrence keys where
 * their subsystem supports them.
 */
export async function runPostCompletion(req: CompletedReq): Promise<void> {
  if (!req.sourceSigned) return;
  if (req.quoteId) await afterQuoteSigned(req);
  else if (req.jobCardId) await afterJobCardSigned(req);
}

async function afterQuoteSigned(req: CompletedReq): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: req.quoteId! }, include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
  });
  if (!quote) throw new Error("Signed quote no longer exists for post-completion processing");
  const name = req.signedByName || "Customer";
  const total = payableTotalCents(quote);

  if (req.wonLeadId) {
    await markReferralEarned(req.wonLeadId);
    await emitLeadJourneyEvent("lead_won", req.wonLeadId, {
      occurrence: `signature-request:${req.id}`,
      payload: { signatureRequestId: req.id, quoteId: req.quoteId },
    });
  }
  if (quote.leadId) {
    await emitLeadJourneyEvent("quote_signed", quote.leadId, {
      occurrence: `quote:${quote.id}:signed`,
      payload: { quoteId: quote.id, quoteNumber: quote.number, signatureRequestId: req.id },
    });
  }
  await logAudit({
    action: "quote.signed",
    summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) signed online by ${name} via signing hub — immutable sealed PDF filed${req.signedPdfHash ? ` (SHA-256 ${req.signedPdfHash.slice(0, 16)}…)` : ""}`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    userName: name,
    entityType: "SignatureRequest",
    entityId: req.id,
    source: "signing-outbox",
    metadata: { idempotencyKey: `post-complete:${req.id}`, signedDocId: req.signedDocId },
  });
  await sendPushToAll(
    { title: "Quote signed 🎉", body: `Q-${quote.number} — ${name} · ${formatZAR(Math.round(total))}`, url: `/quotes/${quote.id}` },
    "quote_signed",
  );
}

async function afterJobCardSigned(req: CompletedReq): Promise<void> {
  const jobCard = await prisma.jobCard.findUnique({ where: { id: req.jobCardId! } });
  if (!jobCard) throw new Error("Signed job card no longer exists for post-completion processing");
  const name = req.signedByName || "Customer";
  await logAudit({
    action: "jobcard.signed",
    summary: `Job card #${jobCard.number} signed online by ${name} via signing hub — immutable sealed PDF filed`,
    contactId: jobCard.contactId,
    userName: name,
    entityType: "SignatureRequest",
    entityId: req.id,
    source: "signing-outbox",
    metadata: { idempotencyKey: `post-complete:${req.id}`, signedDocId: req.signedDocId },
  });
  await sendPushToAll(
    { title: "Job card signed ✍", body: `#${jobCard.number} — ${name}`, url: `/jobcards/${jobCard.id}` },
    "quote_signed",
  );
}
