import "server-only";
import { prisma } from "@/lib/db";
import { payableTotalCents } from "@/lib/pricing";
import { logAudit } from "@/lib/audit";
import { sendPushToAll } from "@/lib/push";
import { formatZAR } from "@/lib/format";
import { markReferralEarned } from "@/lib/referrals";
import { emitLeadJourneyEvent } from "@/lib/leadJourneyEvents";
import { describeError } from "./completionFanout";

/**
 * Fire the EXTERNAL side-effects of a signed document once the hub has completed
 * a request. The CORE state — request completed, sealed PDF filed, and the source
 * quote/job card marked signed — is committed atomically inside
 * completeSignatureRequest's transaction. This function only fans out the
 * non-transactional effects (referral, automations, push, audit) and never
 * unwinds an already-completed request.
 *
 * It runs only when the completion transaction actually signed the source
 * (`sourceSigned`), so a source already signed elsewhere / trashed / superseded
 * doesn't re-fire won-effects. `wonLeadId` is set only when that same
 * transaction won the lead, keeping lead effects in step with the quote.
 *
 * ── IT REPORTS WHAT IT SWALLOWED ───────────────────────────────────────────
 *
 * "Best-effort" used to mean `catch (err) { console.error(...) }` and a `void`
 * return: a failed audit write, a failed journey emission, a referral that was
 * never credited — all indistinguishable from success to the caller. That is
 * load-bearing now, because the caller writes the `completed` marker on the
 * strength of this returning, and that marker is the flag that says "this
 * request has been dealt with, never sweep it again". A marker written over
 * swallowed failures is a permanent, invisible loss.
 *
 * So the contract is: still never throw, still never unwind, but say what
 * failed. Each effect is attempted independently — one failing must not skip the
 * ones after it — and the caller withholds the marker when `ok` is false, which
 * leaves the request visible to the sweep and gets it retried.
 *
 * The one deliberate exception is the staff PUSH notification. A push that does
 * not land is a missed toast on someone's phone; treating it as an unfinished
 * fan-out would re-send the customer's signed contract to get a notification
 * badge redelivered. Wrong trade, so it stays fire-and-forget.
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

export type PostCompletionResult = {
  /** True only when every required downstream effect actually landed. */
  ok: boolean;
  /** One entry per effect that did not, safe to log. */
  failures: string[];
};

/** Run one effect, recording rather than hiding a failure, and never letting it skip the rest. */
async function effect(name: string, failures: string[], run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (err) {
    failures.push(`${name}: ${describeError(err)}`);
    console.error(`[signing] post-completion effect "${name}" failed`, err);
  }
}

export async function runPostCompletion(req: CompletedReq): Promise<PostCompletionResult> {
  // Source wasn't newly signed — there is genuinely nothing to fan out, which is
  // a finished fan-out, not a failed one.
  if (!req.sourceSigned) return { ok: true, failures: [] };

  const failures: string[] = [];
  try {
    if (req.quoteId) await afterQuoteSigned(req, failures);
    else if (req.jobCardId) await afterJobCardSigned(req, failures);
  } catch (err) {
    // Never fail completion because a downstream effect threw — but do not
    // pretend it succeeded either.
    failures.push(`post-completion: ${describeError(err)}`);
    console.error("[signing] post-completion side-effects failed", err);
  }
  return { ok: failures.length === 0, failures };
}

async function afterQuoteSigned(req: CompletedReq, failures: string[]): Promise<void> {
  const quote = await prisma.quote.findUnique({
    where: { id: req.quoteId! },
    include: { items: true, fees: { orderBy: { sortOrder: "asc" } } },
  });
  // The quote is gone (trashed, purged). There is nothing to audit or emit
  // against it and no retry can bring it back, so this is a finished fan-out and
  // not a failure — recording one would strand the request forever over a record
  // that no longer exists.
  if (!quote) return;
  const name = req.signedByName || "Customer";
  // What was actually signed for — fees included, matching the document.
  const total = payableTotalCents(quote);

  if (req.wonLeadId) {
    // Money. `markReferralEarned` used to be `.catch(() => {})` — a referrer
    // silently never credited.
    await effect("referral", failures, () => markReferralEarned(req.wonLeadId!));
    // Keyed on the signature request, not the lead's updatedAt: the win was
    // committed inside completeSignatureRequest's transaction, which this
    // function only fans out from, so the lead row may have been touched since.
    await effect("lead_won", failures, () =>
      emitLeadJourneyEvent("lead_won", req.wonLeadId!, {
        occurrence: `signature-request:${req.id}`,
        payload: { signatureRequestId: req.id, quoteId: req.quoteId },
      }),
    );
  }
  await effect("audit", failures, () =>
    logAudit({
      action: "quote.signed",
      summary: `Quote Q-${quote.number} (${formatZAR(Math.round(total))}) signed online by ${name} via signing hub — sealed PDF filed${req.signedPdfHash ? ` (SHA-256 ${req.signedPdfHash.slice(0, 16)}…)` : ""}`,
      contactId: quote.contactId,
      leadId: quote.leadId,
      userName: name,
    }),
  );
  // A quote is signed once, so the quote id alone is the occurrence.
  if (quote.leadId) {
    await effect("quote_signed", failures, () =>
      emitLeadJourneyEvent("quote_signed", quote.leadId!, {
        occurrence: `quote:${quote.id}:signed`,
        payload: { quoteId: quote.id, quoteNumber: quote.number, signatureRequestId: req.id },
      }),
    );
  }
  // Fire-and-forget by design — see the note at the top of the file.
  await sendPushToAll(
    { title: "Quote signed 🎉", body: `Q-${quote.number} — ${name} · ${formatZAR(Math.round(total))}`, url: `/quotes/${quote.id}` },
    "quote_signed"
  ).catch(() => {});
}

async function afterJobCardSigned(req: CompletedReq, failures: string[]): Promise<void> {
  const jobCard = await prisma.jobCard.findUnique({ where: { id: req.jobCardId! } });
  if (!jobCard) return; // same as above: gone, and no retry brings it back
  const name = req.signedByName || "Customer";
  await effect("audit", failures, () =>
    logAudit({
      action: "jobcard.signed",
      summary: `Job card #${jobCard.number} signed online by ${name} via signing hub — sealed PDF filed`,
      contactId: jobCard.contactId,
      userName: name,
    }),
  );
  await sendPushToAll(
    { title: "Job card signed ✍", body: `#${jobCard.number} — ${name}`, url: `/jobcards/${jobCard.id}` },
    "quote_signed"
  ).catch(() => {});
}
