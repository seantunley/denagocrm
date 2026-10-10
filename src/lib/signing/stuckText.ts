/**
 * What a failed follow-up step MEANS, to the person looking at the request.
 *
 * No server imports: the wording is the part worth testing on its own, and the
 * query beside it (stuck.ts) reaches the database.
 *
 * After somebody signs, approves or declines, the request has one more thing to
 * do — finish the sealed PDF, ask the next person, email the approver. That step
 * runs straight away and, if it fails, again from a queue for about a day. While
 * it was failing the request looked healthy: "2/2 signed", still open, no
 * warning, and the only trace was a row in Settings → Background queues.
 */

/** The follow-up steps, as the transition worker names them (transitionWorker.ts). */
export const FOLLOW_UP_STEPS = ["advance_signature", "advance_approval", "approval_notify", "decline_notify"] as const;

/** Waiting to be tried again after a failure, or given up on. */
export const FAILED_STEP_STATUSES = ["transition_retry", "dead"] as const;

export type StuckStep = {
  requestId: string;
  jobType: string;
  status: string;
  attempts: number;
  lastError: string | null;
  /** When the queue will try it next. Meaningless once it has given up. */
  availableAt: Date;
};

/** Everyone who has to sign has signed. Viewers never sign; a request with no signers has nobody to wait for and is not "all signed". */
export function allSignersSigned(recipients: Array<{ role: string; status: string }>): boolean {
  const signers = recipients.filter((recipient) => recipient.role !== "viewer");
  return signers.length > 0 && signers.every((recipient) => recipient.status === "signed");
}

/**
 * How long a fully signed request may stay open before it counts as stuck.
 * Finishing runs straight after the last signature and takes seconds; this only
 * keeps a request that is finishing right now from being flagged.
 */
export const FINISHING_GRACE_MS = 3 * 60 * 1000;

/**
 * Open, everyone has signed, nothing left to wait for — and still not finished.
 *
 * Decided from the request's own state, not from a failed job, because the worst
 * case leaves no failed job to find: the worker was cut off mid-way and its job
 * simply stayed "running". A request waiting on an approval is waiting on a
 * person and is not stalled.
 */
export function finishingStalled(
  req: {
    status: string;
    closed: boolean;
    recipients: Array<{ role: string; status: string; signedAt: Date | null }>;
    approvals: Array<{ status: string }>;
  },
  now: Date,
  graceMs = FINISHING_GRACE_MS,
): boolean {
  if (req.closed || !allSignersSigned(req.recipients)) return false;
  if (req.approvals.some((step) => step.status === "pending")) return false;
  const lastSigned = Math.max(...req.recipients.map((recipient) => recipient.signedAt?.getTime() ?? 0));
  return now.getTime() - lastSigned >= graceMs;
}

export function stuckHeadline(jobType: string, everyoneSigned: boolean): string {
  if (jobType === "advance_signature") return everyoneSigned ? "Everyone signed, but it could not be finished" : "Signed, but the next step did not run";
  if (jobType === "advance_approval") return "Approval decided, but the next step did not run";
  if (jobType === "approval_notify") return "The approver could not be emailed";
  if (jobType === "decline_notify") return "The sender could not be told about a decline";
  return "A follow-up step failed";
}

/** The short form, for a pill in a list. */
export function stuckLabel(jobType: string, everyoneSigned: boolean): string {
  if (jobType === "advance_signature") return everyoneSigned ? "Signed — not finished" : "Next step failed";
  if (jobType === "approval_notify") return "Approver not emailed";
  return "Next step failed";
}

/** What is safe, and what is missing. Never implies a signature was lost — it was not. */
export function stuckExplanation(jobType: string, everyoneSigned: boolean): string {
  if (jobType === "advance_signature") {
    return everyoneSigned
      ? "The signatures are safely recorded. What failed is the last step: making the sealed PDF, marking the record as signed and sending everyone their copy."
      : "The signature is safely recorded, but the next person has not been asked to sign.";
  }
  if (jobType === "advance_approval") return "The decision is recorded, but the document has not been passed on.";
  if (jobType === "approval_notify") return "The approval is waiting, and the approver has not had the email asking for it.";
  if (jobType === "decline_notify") return "The decline is recorded here. Only the message to the sender failed.";
  return "What was done is recorded. The step after it failed.";
}

/** How hard it has been tried, and whether it is still trying. `nextTry` is already formatted for the reader. */
export function stuckProgress(step: Pick<StuckStep, "status" | "attempts">, nextTry: string): string {
  const times = `${step.attempts} time${step.attempts === 1 ? "" : "s"}`;
  if (step.status === "dead") return `It was tried ${times} and has stopped trying by itself.`;
  return `Tried ${times} so far. It tries again by itself — next at ${nextTry}.`;
}

/**
 * Why a step failed, for a person.
 *
 * What the queue records is a driver or library message — accurate, and no use
 * to someone deciding whether to wait, retry or fix something. The full text
 * stays where support can read it (Settings → System log); the screen gets the
 * kind of failure and what it implies.
 *
 * Order matters: the specific causes are tested before the general ones, because
 * "the sealed PDF could not be read" is a storage failure that mentions a PDF.
 */
export function failureInWords(lastError: string | null | undefined): string {
  const error = (lastError ?? "").toLowerCase();
  if (!error.trim()) return "No reason was recorded.";
  if (/lock timeout|deadlock|55p03|40p01|could not obtain lock|transaction already closed|transaction api error|serialization failure/.test(error)) {
    return "The record was busy — something else was saving it at the same moment. This usually clears by itself.";
  }
  if (/smtp|e-?mail|recipient/.test(error)) return "An email could not be sent. Check the address and the mail settings.";
  if (/could not be read|blob|storage|enoent|eacces|no such file/.test(error)) return "A file could not be saved or read.";
  if (/chrom|puppeteer|browser|pdf/.test(error)) return "The PDF could not be made.";
  if (/timeout|timed out|etimedout|econnreset|econnrefused|network|fetch failed/.test(error)) return "It took too long, or a service it needs did not answer.";
  return "An unexpected error.";
}

/** One request can have several failed steps; show the one that blocks the most. */
export function worstStep<T extends Pick<StuckStep, "jobType" | "status">>(steps: T[]): T | null {
  const rank = (step: T) => (step.status === "dead" ? 0 : 10) + FOLLOW_UP_STEPS.indexOf(step.jobType as (typeof FOLLOW_UP_STEPS)[number]);
  return [...steps].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
