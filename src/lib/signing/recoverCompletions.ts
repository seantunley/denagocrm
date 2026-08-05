import "server-only";
import { prisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { sendEmail } from "@/lib/email";
import { logSignEvent } from "./events";
import { runPostCompletion } from "./postComplete";

/**
 * Re-drive completions that committed but never fanned out.
 *
 * ── THE HOLE THIS FILLS ────────────────────────────────────────────────────
 *
 * `completeSignatureRequest` commits the core state — request completed, sealed
 * PDF filed, source quote/job card signed — in one transaction, and does the
 * external work afterwards: the completion event, the post-completion effects,
 * and THE EMAIL THAT SENDS THE CUSTOMER THEIR SIGNED DOCUMENT.
 *
 * If the transaction commits and the client is nonetheless told it failed (a
 * lost commit acknowledgement — see SIGNING-PDF-LOSS-INCIDENT.md), the catch
 * rethrows and none of that external work runs. The request is then stranded
 * beyond reach: `advanceAfterSignature` returns early on `isRequestClosed`, and
 * so does `completeSignatureRequest` itself, so NOTHING re-drives it. The
 * database says completed while the customer never received their contract, no
 * automation fired, and no audit was written.
 *
 * It is also silent: no failed-job row, no alert, and the CRM shows the quote as
 * signed and accepted. Quote Q-1010 sat like that from 2026-08-04 until it was
 * found by hand.
 *
 * ── HOW A STRANDED REQUEST IS IDENTIFIED ───────────────────────────────────
 *
 * By the absence of its own completion event. `logSignEvent("completed")` is now
 * written LAST, after the fan-out rather than before it (see complete.ts), so
 * "status is completed but no completed event exists" means precisely "the
 * transaction committed and the external work did not finish". No new column,
 * no new state machine — the audit trail already had the answer.
 *
 * ── AT LEAST ONCE, DELIBERATELY ────────────────────────────────────────────
 *
 * The marker is written AFTER the work, so a crash mid-recovery re-sends rather
 * than skips. That ordering is chosen with the failure in mind: a customer
 * receiving their signed contract twice is a nuisance, receiving it never is the
 * bug being fixed. Re-firing is safe by construction everywhere it matters —
 * `emitLeadJourneyEvent` dedupes on a stable occurrence key and
 * `markReferralEarned` is guarded on `status === "pending"` — so the duplicate
 * surface is a second audit line and a second email, not a second referral fee.
 *
 * Bounded, though, so a permanently-failing request cannot mail someone forever:
 * each attempt records a marker first, and after MAX_RECOVERY_ATTEMPTS the
 * request is left alone and reported instead. Being left visibly stranded is the
 * correct outcome for one that cannot be repaired automatically — Q-1010, whose
 * PDF no longer exists to attach, is exactly that case and needs a human.
 */

/** Event type recording one recovery attempt. Distinct from `completed`, which marks success. */
export const RECOVERY_ATTEMPT = "recovery_attempt";

/** Give up after this many attempts and report the request instead of retrying forever. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * Ignore very recent completions. A completion in flight has committed but is
 * still doing its fan-out, and would otherwise look identical to a stranded one
 * — so the sweep would race a healthy request and double-send its email.
 */
const SETTLE_MS = 2 * 60 * 1000;

/** Cap the work per tick; the sweep runs on every cron pass and finds nothing almost every time. */
const MAX_PER_RUN = 20;

export type RecoveryResult = { found: number; recovered: number; exhausted: number; failed: number };

export async function recoverStrandedCompletions(): Promise<RecoveryResult> {
  const cutoff = new Date(Date.now() - SETTLE_MS);
  const stranded = await prisma.signatureRequest.findMany({
    where: {
      status: "completed",
      completedAt: { lt: cutoff },
      // The whole detector: completed, but its completion event was never written.
      events: { none: { type: "completed" } },
    },
    select: { id: true, title: true, quoteId: true, jobCardId: true, signedPdfRef: true, signedDocId: true, signedPdfHash: true },
    orderBy: { completedAt: "asc" },
    take: MAX_PER_RUN,
  });

  const result: RecoveryResult = { found: stranded.length, recovered: 0, exhausted: 0, failed: 0 };

  for (const req of stranded) {
    const claim = await claimAttempt(req.id);
    if (claim === "exhausted") {
      result.exhausted += 1;
      console.error(
        `[signing] request ${req.id} ("${req.title}") is stranded after ${MAX_RECOVERY_ATTEMPTS} recovery attempts. ` +
          `It completed but never notified anyone; it needs a person. Not retrying.`,
      );
      continue;
    }
    if (claim === "already-done") continue; // a concurrent run finished it between query and claim

    try {
      await redrive(req);
      // Written LAST: this event is the marker that the fan-out finished.
      await logSignEvent(req.id, {
        type: "completed",
        actor: "system",
        metadata: { hash: req.signedPdfHash, recovered: true },
      });
      result.recovered += 1;
    } catch (err) {
      result.failed += 1;
      console.error(`[signing] recovery failed for request ${req.id} ("${req.title}")`, err);
    }
  }

  return result;
}

/**
 * Record one attempt, under the request row's lock so two concurrent crons
 * cannot both decide to send. Re-checks completion inside the lock, because the
 * winner may have finished between the query above and this claim.
 */
async function claimAttempt(requestId: string): Promise<"claimed" | "exhausted" | "already-done"> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM "SignatureRequest" WHERE id = ${requestId} FOR UPDATE`;
    const done = await tx.signatureEvent.count({ where: { requestId, type: "completed" } });
    if (done > 0) return "already-done";
    const attempts = await tx.signatureEvent.count({ where: { requestId, type: RECOVERY_ATTEMPT } });
    if (attempts >= MAX_RECOVERY_ATTEMPTS) return "exhausted";
    await tx.signatureEvent.create({
      data: { requestId, type: RECOVERY_ATTEMPT, actor: "system", metadata: { attempt: attempts + 1 } },
    });
    return "claimed";
  });
}

/** The external work the original completion never got to. Throws if it cannot finish. */
async function redrive(req: {
  id: string;
  title: string;
  quoteId: string | null;
  jobCardId: string | null;
  signedPdfRef: string | null;
  signedDocId: string | null;
  signedPdfHash: string | null;
}): Promise<void> {
  const recipients = await prisma.signatureRecipient.findMany({
    where: { requestId: req.id },
    orderBy: { order: "asc" },
    select: { name: true, email: true, role: true, status: true, signedName: true },
  });

  // Rebuild the two flags the original transaction computed, from committed
  // state rather than from memory that no longer exists. `sourceSigned` asks the
  // same question the transaction did — is the source live and signed — and
  // `wonLeadId` is only set when the lead actually reads `won`, so a lead that
  // was moved on since is not re-won here.
  let sourceSigned = false;
  let wonLeadId: string | null = null;
  if (req.quoteId) {
    const quote = await prisma.quote.findUnique({
      where: { id: req.quoteId },
      select: { signedAt: true, deletedAt: true, supersededAt: true, leadId: true },
    });
    sourceSigned = Boolean(quote?.signedAt && !quote.deletedAt && !quote.supersededAt);
    if (sourceSigned && quote?.leadId) {
      const lead = await prisma.lead.findUnique({ where: { id: quote.leadId }, select: { status: true, deletedAt: true } });
      if (lead && !lead.deletedAt && lead.status === "won") wonLeadId = quote.leadId;
    }
  } else if (req.jobCardId) {
    const jc = await prisma.jobCard.findUnique({ where: { id: req.jobCardId }, select: { signedAt: true, deletedAt: true } });
    sourceSigned = Boolean(jc?.signedAt && !jc.deletedAt);
  }

  const firstSigner = recipients.find((r) => r.status === "signed" && r.role !== "viewer");
  await runPostCompletion({
    id: req.id,
    title: req.title,
    quoteId: req.quoteId,
    jobCardId: req.jobCardId,
    signedByName: firstSigner?.signedName || firstSigner?.name || "Customer",
    signedPdfHash: req.signedPdfHash,
    signedDocId: req.signedDocId,
    sourceSigned,
    wonLeadId,
  });

  // The email is the point of the exercise, so a request whose sealed PDF can no
  // longer be read must NOT be marked recovered — sending "your signed document
  // is attached" with nothing attached is worse than the silence. Throwing here
  // leaves it stranded and visible, which is the honest state and the one that
  // gets a person to look.
  if (!req.signedPdfRef) throw new Error("no signedPdfRef — cannot send the signed document");
  const pdf = await readFile(req.signedPdfRef);

  for (const r of recipients) {
    if (!r.email) continue;
    await sendEmail({
      to: r.email,
      subject: `Completed & signed: ${req.title}`,
      text: `Hi ${r.name},\n\nEveryone has signed "${req.title}". The final sealed PDF is attached.\n\nDenago Cape Town`,
      attachments: [{ filename: `${req.title}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }
}
