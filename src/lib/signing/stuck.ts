import "server-only";
import { prisma } from "@/lib/db";
import { CLOSED_REQUEST_STATUSES } from "./status";
import { COMPLETION_BLOCKED_EVENT } from "./complete";
import { FAILED_STEP_STATUSES, FINISHING_GRACE_MS, FOLLOW_UP_STEPS, type StuckStep } from "./stuckText";

/**
 * The list form of `finishingStalled` (stuckText.ts): a `where` for requests
 * that are open, signed by everyone, waiting on no approval — and still not
 * finished. One that completion has already reported as blocked (its quote or
 * job card changed) is left to that report, which says what to do about it.
 */
export function finishingStalledWhere(now = new Date()) {
  const cutoff = new Date(now.getTime() - FINISHING_GRACE_MS);
  return {
    status: { notIn: [...CLOSED_REQUEST_STATUSES] },
    recipients: {
      some: { role: { not: "viewer" } },
      every: { OR: [{ role: "viewer" }, { status: "signed" }] },
      none: { signedAt: { gt: cutoff } },
    },
    approvals: { none: { status: "pending" } },
    events: { none: { type: COMPLETION_BLOCKED_EVENT } },
  };
}

/**
 * The follow-up steps that have FAILED — for the requests given, or for every
 * request in the workspace.
 *
 * `lastError` is what separates a failure from a step that merely waited its
 * turn: the worker puts a job back without one when another worker holds the
 * request, and clears it when the step succeeds.
 *
 * The guarded client scopes this to the acting workspace.
 */
export async function stuckSteps(requestIds?: string[]): Promise<StuckStep[]> {
  if (requestIds && requestIds.length === 0) return [];
  return prisma.signingJob.findMany({
    where: {
      jobType: { in: [...FOLLOW_UP_STEPS] },
      status: { in: [...FAILED_STEP_STATUSES] },
      lastError: { not: null },
      ...(requestIds ? { requestId: { in: requestIds } } : {}),
    },
    select: { requestId: true, jobType: true, status: true, attempts: true, lastError: true, availableAt: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
}

/**
 * Make a request's failed steps due NOW, including ones the queue gave up on.
 *
 * It does not run them — the transition worker does, under the same lease and
 * with the same bookkeeping as every other attempt. Returns how many were put
 * back.
 */
export async function reviveStuckSteps(requestId: string, tenantId: string): Promise<number> {
  const now = new Date();
  const revived = await prisma.signingJob.updateMany({
    where: {
      tenantId,
      requestId,
      jobType: { in: [...FOLLOW_UP_STEPS] },
      status: { in: [...FAILED_STEP_STATUSES] },
      lastError: { not: null },
    },
    data: { status: "transition_retry", availableAt: now, leaseUntil: null, leaseOwner: null, updatedAt: now },
  });
  return revived.count;
}
