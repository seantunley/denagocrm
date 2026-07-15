import "server-only";
import { prisma, basePrisma } from "@/lib/db";
import { quoteTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { formatZAR } from "@/lib/format";
import { markReferralEarned } from "@/lib/referrals";
import { runLeadAutomations } from "@/lib/automations";

/**
 * Fire the CRM side-effects of a signed document once the hub has completed a
 * request. This is what gives the unified signing hub parity with the legacy
 * `/sign/[kind]/[token]` flow: a signed quote is *accepted* and wins its lead;
 * a signed job card is marked signed. Called from completeSignatureRequest after
 * the sealed PDF has been filed.
 *
 * Every step is idempotent (guarded on the record not already being signed) and
 * best-effort — a failure here must never unwind an already-completed request.
 */

type CompletedReq = {
  id: string;
  title: string;
  quoteId: string | null;
  jobCardId: string | null;
  signedByName: string | null;
  signedPdfHash: string | null;
  signedDocId: string | null;
};

export async function runPostCompletion(req: CompletedReq): Promise<void> {
  try {
    if (req.quoteId) await acceptQuote(req);
    else if (req.jobCardId) await signJobCard(req);
  } catch (err) {
    // Never fail completion because a downstream effect threw.
    console.error("[signing] post-completion side-effects failed", err);
  }
}

/** Accept the quote, win its lead, fire referral + automations + push. */
async function acceptQuote(req: CompletedReq): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: req.quoteId! },
    include: { items: true, lead: true },
  });
  if (!quote || quote.signedAt) return; // already accepted (legacy or a prior run)

  const signedAt = new Date();
  const name = req.signedByName || "Customer";
  // Atomic claim mirrors the legacy flow: only one path can accept the quote.
  const claimed = await basePrisma.quote.updateMany({
    where: { id: quote.id, signedAt: null },
    data: {
      signedAt,
      signedByName: name,
      status: "accepted",
      declinedAt: null,
      declineReason: null,
      signedPdfHash: req.signedPdfHash ?? undefined,
    },
  });
  if (claimed.count === 0) return;

  if (quote.leadId && quote.lead?.status === "open") {
    await prisma.lead.update({ where: { id: quote.leadId }, data: { status: "won" } });
    await markReferralEarned(quote.leadId).catch(() => {});
    await runLeadAutomations("lead_won", quote.leadId).catch(() => {});
  }

  const total = quoteTotalCents(quote.items);
  await logAudit({
    action: "quote.signed",
    summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) signed online by ${name} via signing hub — sealed PDF filed${req.signedPdfHash ? ` (SHA-256 ${req.signedPdfHash.slice(0, 16)}…)` : ""}`,
    contactId: quote.contactId,
    leadId: quote.leadId,
    userName: name,
  });

  if (quote.leadId) await runLeadAutomations("quote_signed", quote.leadId).catch(() => {});
  await sendPushToAll(
    { title: "Quote signed 🎉", body: `Q-${quote.number} — ${name} · ${formatZAR(Math.round(total))}`, url: `/quotes/${quote.id}` },
    "quote_signed"
  ).catch(() => {});
}

/** Mark the job card signed + notify. */
async function signJobCard(req: CompletedReq): Promise<void> {
  const jobCard = await prisma.jobCard.findUnique({ where: { id: req.jobCardId! } });
  if (!jobCard || jobCard.signedAt) return;

  const signedAt = new Date();
  const name = req.signedByName || "Customer";
  const claimed = await basePrisma.jobCard.updateMany({
    where: { id: jobCard.id, signedAt: null },
    data: { signedAt, signedByName: name },
  });
  if (claimed.count === 0) return;

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
