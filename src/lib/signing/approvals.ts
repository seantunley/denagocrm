import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";
import { advanceWorkflow } from "@/lib/signflow/runtime";
import { resolveTenantActor, resolveTenantMemberUser } from "@/lib/tenantActor";
import { tenantEnforcing } from "@/lib/tenantEnforcement";
import { DEFAULT_BRAND, brandForTenant } from "@/lib/tenantBrand";
import { tenantOrigin } from "@/lib/tenantOrigin";

/** Platform origin and last resort — see signUrl in ./dispatch for the ordering. */
const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";

export function approvalUrl(token: string, origin?: string | null): string {
  return `${process.env.SIGN_BASE_URL || origin || BASE}/approvals/${token}`;
}

/** Resolve who should be notified for an approval step (name + email). Exported for tests. */
export async function resolveApprover(step: { assigneeType: string; assigneeUserId: string | null; assigneeRole: string | null; assigneeName: string | null; assigneeEmail: string | null }): Promise<{ name: string; email: string | null }> {
  if (step.assigneeType === "staff") {
    // Validate the stored assignee is STILL an active, non-disabled member of THIS
    // request's tenant. `User` is global, so an unscoped lookup would happily return
    // a cross-tenant/stale/disabled user and email them this tenant's document +
    // token. Branch on the TYPE (not `&& assigneeUserId`) so a malformed/legacy
    // staff step with a null/unresolved id also fails closed under enforcement
    // rather than leaking to a stored email.
    const u = step.assigneeUserId ? await resolveTenantMemberUser(step.assigneeUserId) : null;
    if (u) return { name: u.name, email: u.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  if (step.assigneeType === "owner") {
    // The OWNER of this request's tenant — never the first global owner, which
    // could belong to another tenant and be emailed this document.
    const u = await resolveTenantActor({ ownerOnly: true });
    if (u) return { name: u.name, email: u.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  // role, or the DORMANT fallback for an unresolved staff/owner: the typed email/name.
  return { name: step.assigneeName || step.assigneeRole || "Approver", email: step.assigneeEmail };
}

/** Email the approver a link to review + approve/reject (best-effort). */
export async function notifyApprover(stepId: string): Promise<void> {
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
  if (!step) return;
  // Don't email an approval link for a request that has already closed
  // (completed/voided/declined/expired/rejected) — the link would be dead.
  if (isRequestClosed(step.request.status)) return;
  const who = await resolveApprover(step);
  // The workspace this request belongs to — its own domain for the link, and its
  // own name at the foot of the mail. This said "Denago Cape Town" to every
  // tenant's approvers, on a mail asking them to approve their own document.
  const [origin, brand] = await Promise.all([
    tenantOrigin(step.request.tenantId),
    brandForTenant(step.request.tenantId).catch(() => DEFAULT_BRAND),
  ]);
  const url = approvalUrl(step.token, origin);
  if (who.email) {
    await sendEmail({
      to: who.email,
      subject: `Approval needed: ${step.request.title}`,
      text: `Hi ${who.name},\n\n"${step.request.title}" needs your approval (${step.label}).\n\nReview and approve or reject here:\n${url}\n\n${brand.displayName}`,
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
  // Claim only a pending step whose PARENT request is still open — atomically, via
  // a relation filter — so a step can't be actioned after the request was
  // completed/voided/declined/expired/rejected.
  const claimed = await prisma.approvalStep.updateMany({
    where: { id: stepId, status: "pending", request: { status: { notIn: [...CLOSED_REQUEST_STATUSES] } } },
    data: { status: "approved", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "This approval can no longer be actioned." };
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
    where: { id: stepId, status: "pending", request: { status: { notIn: [...CLOSED_REQUEST_STATUSES] } } },
    data: { status: "rejected", decidedByUserId: by.userId ?? null, decidedByName: by.name, decidedAt: new Date(), reason: reason.slice(0, 500) },
  });
  if (claimed.count === 0) return { ok: false, error: "This approval can no longer be actioned." };
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (step) {
    await logSignEvent(step.requestId, { type: "rejected", actor: by.name, metadata: { label: step.label, reason } });
    await advanceWorkflow(step.requestId);
  }
  return { ok: true };
}
