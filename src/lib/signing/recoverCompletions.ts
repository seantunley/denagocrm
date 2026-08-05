import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { logError } from "@/lib/errorLog";
import { runInTenantScope } from "@/lib/tenantScope";
import { logSignEvent } from "./events";
import { runPostCompletion } from "./postComplete";
import {
  COMPLETED_EVENT,
  POST_COMPLETION_EVENT,
  RECOVERY_ATTEMPT_EVENT,
  deliverCompletionEmails,
  describeError,
  type FanoutRecipient,
} from "./completionFanout";
import { sweepTenantWhere, sourceSignedByThisRequest, type SweepTenantWhere } from "./recoveryScope";

/**
 * Re-drive completions that committed but never fanned out.
 *
 * ── THE HOLE THIS FILLS ────────────────────────────────────────────────────
 *
 * `completeSignatureRequest` commits the core state — request completed, sealed
 * PDF filed, source quote/job card signed — in one transaction, and does the
 * external work afterwards: the post-completion effects, THE EMAIL THAT SENDS
 * THE CUSTOMER THEIR SIGNED DOCUMENT, and only then the completion event.
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
 * By the absence of its own completion event. `logSignEvent("completed")` is
 * written LAST, after the fan-out rather than before it, and ONLY when the
 * fan-out reports success (see complete.ts), so "status is completed but no
 * completed event exists" means precisely "the transaction committed and the
 * external work did not finish". No new state machine — the audit trail already
 * had the answer.
 *
 * ── ONE WORKER AT A TIME, PROVEN BY A LEASE ────────────────────────────────
 *
 * This sweep sends mail, so overlapping runs are not a tidiness problem: three
 * cron passes racing would email every recipient three times and burn the whole
 * retry budget in one tick. A row lock cannot prevent that — the lock lives
 * inside a transaction and the transaction commits BEFORE any sending starts, so
 * the external work is unprotected exactly when it matters. A LEASE can: one
 * conditional UPDATE moves `recoveryLeaseUntil` into the future, and every other
 * worker's identical UPDATE matches zero rows until it expires. It expires
 * because a worker killed mid-send would otherwise strand the request forever,
 * which is the failure this file exists to end.
 *
 * ── AT LEAST ONCE, DELIBERATELY, BUT NOT MORE THAN NEEDED ──────────────────
 *
 * Markers are written AFTER the work, so a crash mid-recovery re-sends rather
 * than skips: a customer receiving their signed contract twice is a nuisance,
 * receiving it never is the bug being fixed. The duplicate surface is then
 * narrowed as far as it can honestly be narrowed — delivery is recorded PER
 * RECIPIENT, so a retry mails only whoever is still missing it, and
 * `runPostCompletion` gets its own marker, so a retry caused by one bad address
 * does not write a second audit line for a sale that was already booked.
 *
 * Bounded, too: after MAX_RECOVERY_ATTEMPTS the request is recorded as exhausted
 * — which both stops the retries and takes it out of the candidate query, so it
 * cannot sit in the oldest-first batch forever crowding out newer, still
 * recoverable failures. Being left visibly stranded is the correct outcome for
 * one that cannot be repaired automatically: Q-1010, whose PDF no longer exists
 * to attach, is exactly that case and needs a person.
 */

/** Event type recording one recovery attempt. Distinct from `completed`, which marks success. */
export const RECOVERY_ATTEMPT = RECOVERY_ATTEMPT_EVENT;

/** Give up after this many attempts and report the request instead of retrying forever. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/**
 * How long one worker may hold a request while it does the external work.
 *
 * Comfortably longer than a full re-drive (a handful of emails with a PDF
 * attached) and longer than the cron's own 60s ceiling, so a slow-but-alive
 * worker never has its request taken from under it. Short enough that a worker
 * killed mid-send releases it within a couple of cron passes rather than
 * blocking recovery until someone notices.
 */
export const RECOVERY_LEASE_MS = 10 * 60 * 1000;

/**
 * Ignore very recent completions. A completion in flight has committed but is
 * still doing its fan-out, and would otherwise look identical to a stranded one
 * — so the sweep would race a healthy request and double-send its email.
 */
const SETTLE_MS = 2 * 60 * 1000;

/** Cap the work per tick; the sweep runs on every cron pass and finds nothing almost every time. */
const MAX_PER_RUN = 20;

export type RecoveryResult = {
  found: number;
  recovered: number;
  exhausted: number;
  failed: number;
  /** Skipped because another worker held the lease. Not an error — the point of the lease. */
  leased: number;
};

type StrandedRequest = {
  id: string;
  title: string;
  quoteId: string | null;
  jobCardId: string | null;
  signedPdfRef: string | null;
  signedDocId: string | null;
  signedPdfHash: string | null;
};

/**
 * Sweep ONE tenant. The tenant id is an argument, not something inferred.
 *
 * It has to be, for two reasons that only bite in production. The db.ts guard
 * rewrites query args solely under `tenantEnforcing()`, which is false in every
 * environment today, so ambient scope confines nothing; and `sendEmail` resolves
 * its SMTP credentials from `currentTenantScope()`. An unscoped sweep running
 * under dormant cron mode — which binds the FOUNDING tenant's scope and runs
 * once — could therefore pick up another tenant's stranded request and post
 * their signed contract out over the founding tenant's mail identity.
 *
 * So: every query below carries {@link sweepTenantWhere}, and the whole sweep
 * runs inside an explicit scope for the same tenant, so the mail goes out as
 * them and not as whoever the caller happened to be.
 */
export async function recoverStrandedCompletions(tenantId: string): Promise<RecoveryResult> {
  const where = sweepTenantWhere(tenantId); // throws on a missing/blank tenant — fail closed
  return runInTenantScope({ tenantId, system: false }, () => sweep(where));
}

async function sweep(where: SweepTenantWhere): Promise<RecoveryResult> {
  const cutoff = new Date(Date.now() - SETTLE_MS);
  const stranded = await prisma.signatureRequest.findMany({
    where: {
      ...where,
      status: "completed",
      completedAt: { lt: cutoff },
      // Requests we have already given up on are OUT of the candidate set. They
      // are stranded forever by definition, so leaving them in would let 20 of
      // them fill the oldest-first batch and starve every newer failure.
      recoveryExhaustedAt: null,
      // The whole detector: completed, but its completion event was never written.
      //
      // Deliberately NOT tenant-filtered inside the `none`. Narrowing a
      // SUPPRESSOR widens the candidate set: a completion marker this predicate
      // could not see would be a request re-driven after it had already fanned
      // out, i.e. a second copy of the contract in the customer's inbox. The
      // tenant boundary is enforced on the request itself, above.
      events: { none: { type: COMPLETED_EVENT } },
    },
    select: {
      id: true,
      title: true,
      quoteId: true,
      jobCardId: true,
      signedPdfRef: true,
      signedDocId: true,
      signedPdfHash: true,
    },
    orderBy: { completedAt: "asc" },
    take: MAX_PER_RUN,
  });

  const result: RecoveryResult = {
    found: stranded.length,
    recovered: 0,
    exhausted: 0,
    failed: 0,
    leased: 0,
  };

  for (const req of stranded) {
    const claim = await claimLease(req.id, where);
    if (claim.status === "held") {
      // Another worker is mid-send on this one. Exactly what the lease is for.
      result.leased += 1;
      continue;
    }
    if (claim.status === "already-done") continue; // a concurrent run finished it
    if (claim.status === "exhausted") {
      result.exhausted += 1;
      await reportExhausted(req);
      continue;
    }

    let outcome: { ok: boolean; failures: string[] };
    try {
      outcome = await redrive(req, where);
    } catch (err) {
      outcome = { ok: false, failures: [describeError(err)] };
    }

    if (outcome.ok) {
      // Written LAST: this event is the marker that the fan-out finished.
      await logSignEvent(req.id, {
        type: COMPLETED_EVENT,
        actor: "system",
        metadata: { hash: req.signedPdfHash, recovered: true },
      });
      result.recovered += 1;
      await releaseLease(req.id, where, claim.owner);
      continue;
    }

    result.failed += 1;
    await reportFailure(req, outcome.failures);
    if (claim.attempt >= MAX_RECOVERY_ATTEMPTS) {
      // That was the last attempt. Record it now rather than discovering it on
      // the next pass, so the request leaves the candidate set immediately.
      await markExhausted(req.id, where);
      result.exhausted += 1;
      await reportExhausted(req);
    }
    // The lease is NOT released after a failure. Letting it run out means the
    // next attempt is a fresh cron pass rather than a same-tick retry against
    // whatever is still broken.
  }

  return result;
}

type Claim =
  | { status: "claimed"; owner: string; attempt: number }
  | { status: "held" }
  | { status: "already-done" }
  | { status: "exhausted" };

/**
 * Take the lease, then decide under it.
 *
 * The order matters and the previous version had it backwards. Counting
 * attempts and re-checking completion BEFORE acquiring exclusivity means two
 * workers can both read "no completion, one attempt used" and then both proceed.
 * Acquiring first makes every subsequent read a read nobody else can be racing:
 * from here to the end of the re-drive, this worker is the only one that can be
 * doing anything to this request.
 */
async function claimLease(requestId: string, where: SweepTenantWhere): Promise<Claim> {
  const now = new Date();
  const owner = crypto.randomUUID();

  // ONE conditional UPDATE. Postgres serialises the matching rows, so of two
  // concurrent workers exactly one gets count 1 and the other gets 0 — and the
  // winner holds it for RECOVERY_LEASE_MS, which is what the FOR UPDATE version
  // could not do: that lock was gone the moment its transaction committed, long
  // before the first email was sent.
  const claimed = await prisma.signatureRequest.updateMany({
    where: {
      ...where,
      id: requestId,
      status: "completed",
      recoveryExhaustedAt: null,
      OR: [{ recoveryLeaseUntil: null }, { recoveryLeaseUntil: { lt: now } }],
    },
    data: {
      recoveryLeaseUntil: new Date(now.getTime() + RECOVERY_LEASE_MS),
      recoveryLeaseOwner: owner,
    },
  });
  if (claimed.count !== 1) return { status: "held" };

  // Under the lease now.
  const done = await prisma.signatureEvent.count({
    where: { requestId, type: COMPLETED_EVENT },
  });
  if (done > 0) {
    await releaseLease(requestId, where, owner);
    return { status: "already-done" };
  }

  const attempts = await prisma.signatureEvent.count({
    where: { requestId, type: RECOVERY_ATTEMPT_EVENT },
  });
  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    await markExhausted(requestId, where);
    return { status: "exhausted" };
  }

  // Recorded BEFORE the work, so a crash mid-send still spends an attempt and
  // the cap holds.
  await prisma.signatureEvent.create({
    data: {
      requestId,
      type: RECOVERY_ATTEMPT_EVENT,
      actor: "system",
      metadata: { attempt: attempts + 1, lease: owner },
    },
  });
  return { status: "claimed", owner, attempt: attempts + 1 };
}

/** Give the lease back, but only if we still hold it. */
async function releaseLease(
  requestId: string,
  where: SweepTenantWhere,
  owner: string,
): Promise<void> {
  try {
    await prisma.signatureRequest.updateMany({
      where: { ...where, id: requestId, recoveryLeaseOwner: owner },
      data: { recoveryLeaseUntil: null, recoveryLeaseOwner: null },
    });
  } catch (err) {
    // An unreleased lease expires on its own; failing here must not turn a
    // successful recovery into a reported failure.
    console.error(`[signing] could not release the recovery lease on ${requestId}`, err);
  }
}

/** Record that we have stopped trying, and free the lease so the state is unambiguous. */
async function markExhausted(requestId: string, where: SweepTenantWhere): Promise<void> {
  try {
    await prisma.signatureRequest.updateMany({
      where: { ...where, id: requestId },
      data: { recoveryExhaustedAt: new Date(), recoveryLeaseUntil: null, recoveryLeaseOwner: null },
    });
  } catch (err) {
    console.error(`[signing] could not mark request ${requestId} as exhausted`, err);
  }
}

/**
 * A durable, operator-visible signal.
 *
 * `console.error` in a serverless function is a line in a log nobody reads,
 * which is how Q-1010 stayed lost for a day. `logError` writes a row that
 * surfaces in Settings → System Log and pushes once per tenant per half hour.
 */
async function reportExhausted(req: StrandedRequest): Promise<void> {
  const message =
    `Signature request ${req.id} ("${req.title}") completed but was never notified, ` +
    `and ${MAX_RECOVERY_ATTEMPTS} automatic recovery attempts did not fix it. ` +
    `The customer has no signed document. This needs a person.`;
  console.error(`[signing] ${message}`);
  await logError("signing-recovery-exhausted", new Error(message), `request ${req.id}`).catch(() => {});
}

async function reportFailure(req: StrandedRequest, failures: string[]): Promise<void> {
  const message =
    `Recovery of signature request ${req.id} ("${req.title}") did not finish: ` +
    failures.join("; ");
  console.error(`[signing] ${message}`);
  await logError("signing-recovery", new Error(message), `request ${req.id}`).catch(() => {});
}

/**
 * The external work the original completion never got to.
 *
 * Returns what did and did not land rather than throwing, so the caller can
 * withhold the completion marker precisely when something is still owed.
 */
async function redrive(
  req: StrandedRequest,
  where: SweepTenantWhere,
): Promise<{ ok: boolean; failures: string[] }> {
  const failures: string[] = [];

  // The email is the point of the exercise, so a request whose sealed PDF can no
  // longer be read must NOT be marked recovered — sending "your signed document
  // is attached" with nothing attached is worse than the silence. Failing here
  // leaves it stranded and visible, which is the honest state and the one that
  // gets a person to look. Checked FIRST, before any effect fires.
  if (!req.signedPdfRef) {
    return { ok: false, failures: ["no signedPdfRef — the sealed PDF was never filed"] };
  }
  let pdf: Buffer;
  try {
    pdf = await readFile(req.signedPdfRef);
  } catch (err) {
    return { ok: false, failures: [`the sealed PDF could not be read: ${describeError(err)}`] };
  }

  const recipients = await prisma.signatureRecipient.findMany({
    where: { ...where, requestId: req.id },
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      status: true,
      signedName: true,
      completedEmailSentAt: true,
    },
  });

  // Skip the effects if a previous pass already landed them. Without this, a
  // retry caused by ONE undeliverable address re-fires the automations and
  // writes a second audit line for a sale that was already booked.
  const fannedOut = await prisma.signatureEvent.count({
    where: { requestId: req.id, type: POST_COMPLETION_EVENT },
  });
  if (fannedOut === 0) {
    const firstSigner = recipients.find((r) => r.status === "signed" && r.role !== "viewer");
    const { sourceSigned, wonLeadId } = await reconstructOutcome(req, where);
    const post = await runPostCompletion({
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
    if (post.ok) {
      await logSignEvent(req.id, {
        type: POST_COMPLETION_EVENT,
        actor: "system",
        metadata: { recovered: true },
      });
    } else {
      failures.push(...post.failures);
    }
  }

  const delivery = await deliverCompletionEmails({
    title: req.title,
    pdf,
    recipients: recipients as FanoutRecipient[],
    tenantWhere: where,
  });
  failures.push(...delivery.failures);

  return { ok: failures.length === 0, failures };
}

/**
 * What the ORIGINAL completion transaction did to the source record.
 *
 * `sourceSigned` does NOT mean "the source is signed". It means "THIS
 * transaction changed it from unsigned to signed" — it was set only when a
 * conditional `updateMany(... signedAt: null)` matched a row — and it gates the
 * won-effects: quote_signed, lead-won, referral crediting, audit, staff push.
 *
 * Reconstructing it as "does the source have a signedAt" is a different question
 * with a different answer, and the difference is not academic: a request that
 * completed after another path had already signed the quote answers yes, and
 * gets recovered as though it had done the signing — re-firing every won-effect
 * for a sale that was already booked. `signedPdfHash` is the evidence that tells
 * the two apart; see {@link sourceSignedByThisRequest}.
 */
async function reconstructOutcome(
  req: StrandedRequest,
  where: SweepTenantWhere,
): Promise<{ sourceSigned: boolean; wonLeadId: string | null }> {
  if (req.quoteId) {
    // findFirst, not findUnique: findUnique cannot carry a tenant predicate as a
    // plain filter. The db.ts soft-delete filter adds `deletedAt: null`, so a
    // trashed quote is already excluded.
    const quote = await prisma.quote.findFirst({
      where: { ...where, id: req.quoteId },
      select: { signedAt: true, signedPdfHash: true, supersededAt: true, leadId: true },
    });
    const sourceSigned = Boolean(
      quote?.signedAt &&
        !quote.supersededAt &&
        sourceSignedByThisRequest(req.signedPdfHash, quote.signedPdfHash),
    );
    if (!sourceSigned || !quote?.leadId) return { sourceSigned, wonLeadId: null };
    const lead = await prisma.lead.findFirst({
      where: { ...where, id: quote.leadId },
      select: { status: true },
    });
    // Only when the lead actually reads `won`, so one that has since been moved
    // on is not re-won here.
    return { sourceSigned, wonLeadId: lead?.status === "won" ? quote.leadId : null };
  }

  if (req.jobCardId) {
    const jobCard = await prisma.jobCard.findFirst({
      where: { ...where, id: req.jobCardId },
      select: { signedAt: true, signedPdfHash: true },
    });
    return {
      sourceSigned: Boolean(
        jobCard?.signedAt && sourceSignedByThisRequest(req.signedPdfHash, jobCard.signedPdfHash),
      ),
      wonLeadId: null,
    };
  }

  return { sourceSigned: false, wonLeadId: null };
}
