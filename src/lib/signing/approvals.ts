import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent } from "./events";
import { advanceWorkflow } from "@/lib/signflow/runtime";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";

export function approvalUrl(token: string): string {
  return `${BASE}/approvals/${token}`;
}

/** Resolve who should be notified for an approval step (name + email). */
async function resolveApprover(step: { assigneeType: string; assigneeUserId: string | null; assigneeRole: string | null; assigneeName: string | null; assigneeEmail: string | null }): Promise<{ name: string; email: string | null }> {
  if (step.assigneeType === "staff" && step.assigneeUserId) {
    const u = await prisma.user.findUnique({ where: { id: step.assigneeUserId }, select: { name: true, email: true } });
    if (u) return { name: u.name, email: u.email };
  }
  if (step.assigneeType === "owner") {
    const u = await prisma.user.findFirst({ where: { role: "owner" }, orderBy: { createdAt: "asc" }, select: { name: true, email: true } });
    if (u) return { name: u.name, email: u.email };
  }
  // role or fallback: use the typed email/name if given
  return { name: step.assigneeName || step.assigneeRole || "Approver", email: step.assigneeEmail };
}

/** Email the approver a link to review + approve/reject (best-effort). */
export async function notifyApprover(stepId: string): Promise<void> {
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
  if (!step) return;
  const who = await resolveApprover(step);
  const url = approvalUrl(step.token);
  if (who.email) {
    await sendEmail({
      to: who.email,
      subject: `Approval needed: ${step.request.title}`,
      text: `Hi ${who.name},\n\n"${step.request.title}" needs your approval (${step.label}).\n\nReview and approve or reject here:\n${url}\n\nDenago Cape Town`,
    }).catch(() => {});
  }
  await logSignEvent(step.requestId, { type: "approval_sent", actor: "system", channel: "email", metadata: { to: who.email, label: step.label } });
}

/** Whether a user is allowed to act on this approval step from inside the app. */
export function canActOnStep(step: { assigneeType: string; assigneeUserId: string | null }, user: { id: string; role: string }): boolean {
  if (user.role === "owner") return true; // owners/admins can action any step
  if (step.assigneeType === "staff") return step.assigneeUserId === user.id;
  return false; // role/owner steps require owner (kept strict for v1)
}

/** Approve a step → advance the workflow down the approved branch. */
export async function approveStep(stepId: string, by: { userId?: string; name: string }): Promise<{ ok: boolean; error?: string }> {
  const claimed = await prisma.approvalStep.updateMany({
    where: { id: stepId, status: "pending" },
    data: { status: "approved", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "This approval has already been actioned." };
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (step) {
    await logSignEvent(step.requestId, { type: "approved", actor: by.name, metadata: { label: step.label } });
    await advanceWorkflow(step.requestId);
  }
  return { ok: true };
}

/** Reject a step → advance down the rejected branch (or reject the request). */
export async function rejectStep(stepId: string, by: { userId?: string; name: string }, reason: string): Promise<{ ok: boolean; error?: string }> {
  const claimed = await prisma.approvalStep.updateMany({
    where: { id: stepId, status: "pending" },
    data: { status: "rejected", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date(), reason: reason.slice(0, 500) },
  });
  if (claimed.count === 0) return { ok: false, error: "This approval has already been actioned." };
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (step) {
    await logSignEvent(step.requestId, { type: "rejected", actor: by.name, metadata: { label: step.label, reason } });
    await advanceWorkflow(step.requestId);
  }
  return { ok: true };
}
