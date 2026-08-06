import "server-only";
import { prisma, basePrisma } from "@/lib/db";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";
import { advanceWorkflow } from "@/lib/signflow/runtime";
import { enqueueSigningJob } from "./outbox";
export { approvalUrl } from "./approvalDelivery";

export { resolveApprover } from "./approverResolution";

export async function notifyApprover(stepId: string): Promise<void> {
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
  if (!step?.tenantId || isRequestClosed(step.request.status)) return;
  const jobId = await basePrisma.$transaction((tx) => enqueueSigningJob(tx, {
    tenantId: step.tenantId!, envelopeId: step.requestId, jobType: "deliver_approval",
    payload: { stepId }, idempotencyKey: `approval-delivery:${stepId}`,
  }));
  if (jobId) {
    const { processSigningOutbox } = await import("./outboxWorker");
    await processSigningOutbox({ onlyIds: [jobId], limit: 1 });
  }
}

export function canActOnStep(step: { assigneeType: string; assigneeUserId: string | null }, user: { id: string; role: string }): boolean {
  if (user.role === "owner") return true;
  return step.assigneeType === "staff" && step.assigneeUserId === user.id;
}

export async function approveStep(stepId: string, by: { userId?: string; name: string }): Promise<{ ok: boolean; error?: string }> {
  const claimed = await prisma.approvalStep.updateMany({
    where: { id: stepId, status: "pending", request: { status: { notIn: [...CLOSED_REQUEST_STATUSES] } } },
    data: { status: "approved", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date() },
  });
  if (!claimed.count) return { ok: false, error: "This approval can no longer be actioned." };
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (step) {
    await logSignEvent(step.requestId, { type: "approved", actor: by.name, metadata: { label: step.label, authenticatedUserId: by.userId } });
    await advanceWorkflow(step.requestId);
  }
  return { ok: true };
}

export async function rejectStep(stepId: string, by: { userId?: string; name: string }, reason: string): Promise<{ ok: boolean; error?: string }> {
  const claimed = await prisma.approvalStep.updateMany({
    where: { id: stepId, status: "pending", request: { status: { notIn: [...CLOSED_REQUEST_STATUSES] } } },
    data: { status: "rejected", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date(), reason: reason.slice(0, 500) },
  });
  if (!claimed.count) return { ok: false, error: "This approval can no longer be actioned." };
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (step) {
    await logSignEvent(step.requestId, { type: "rejected", actor: by.name, metadata: { label: step.label, reason, authenticatedUserId: by.userId } });
    await advanceWorkflow(step.requestId);
  }
  return { ok: true };
}
