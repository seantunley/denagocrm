"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { dispatchRequest, notifyRecipient } from "@/lib/signing/dispatch";
import { logSignEvent } from "@/lib/signing/events";
import { approveStep, rejectStep, canActOnStep } from "@/lib/signing/approvals";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "@/lib/signing/status";

/** Approve or reject a pending approval step from inside the app (hub queue). */
export async function decideApproval(stepId: string, decision: "approve" | "reject", reason?: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireCrmOrWorkshop();
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId } });
  if (!step) return { ok: false, error: "Not found" };
  if (step.status !== "pending") return { ok: false, error: "Already actioned." };
  if (!canActOnStep(step, user)) return { ok: false, error: "You are not the assigned approver." };
  const res = decision === "approve"
    ? await approveStep(step.id, { userId: user.id, name: user.name })
    : await rejectStep(step.id, { userId: user.id, name: user.name }, reason ?? "");
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${step.requestId}`);
  return res;
}

export async function sendRequest(requestId: string): Promise<{ ok: boolean; notified?: number; error?: string }> {
  const user = await requirePermission("signing.manage");
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Not found" };
  if (isRequestClosed(req.status)) return { ok: false, error: "This request is closed." };
  const reachable = req.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone));
  if (reachable.length === 0) return { ok: false, error: "Add an email or phone to at least one signer first." };

  const { notified, unreachable } = await dispatchRequest(requestId);
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${requestId}`);
  // Truthful reporting: never log a successful send, or report ok, merely
  // because recipients were targeted — only once a provider actually
  // accepted at least one message (matches sendDocForSigning's rule).
  if (notified === 0) {
    return {
      ok: false,
      notified: 0,
      error: unreachable > 0 ? "No recipient could be reached — check their contact details." : "Delivery failed for every recipient. Try again shortly.",
    };
  }
  await logAudit({ action: "signing.send", summary: `Sent “${req.title}” for signing`, entityType: "SignatureRequest", entityId: requestId, user });
  return { ok: true, notified };
}

/**
 * RE-send an already-sent request. Unlike sendRequest (first dispatch),
 * this must pass `reminder: true` — recipients already in "sent"/"viewed"
 * are otherwise silently skipped by notifyRecipient's at-most-once
 * pending→sent claim, while dispatchRequest's `notified` count still
 * includes them, so the hub reported "Sent to N recipient(s)" when nothing
 * actually went out. Mirrors the already-correct resendRecordSigning.
 */
export async function resendRequest(requestId: string): Promise<{ ok: boolean; notified?: number; error?: string }> {
  const user = await requirePermission("signing.manage");
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } });
  if (!req || req.deletedAt) return { ok: false, error: "Not found" };
  if (req.status === "draft") return { ok: false, error: "This request hasn't been sent yet." };
  if (isRequestClosed(req.status)) return { ok: false, error: "This request is closed." };
  const reachable = req.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone));
  if (reachable.length === 0) return { ok: false, error: "Add an email or phone to at least one signer first." };

  const { notified } = await dispatchRequest(requestId, { reminder: true });
  await logAudit({ action: "signing.remind", summary: `Resent “${req.title}” for signing`, entityType: "SignatureRequest", entityId: requestId, user });
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${requestId}`);
  return { ok: true, notified };
}

export async function remindRecipient(recipientId: string): Promise<{ ok: boolean }> {
  const user = await requirePermission("signing.manage");
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId } });
  if (!r) return { ok: false };
  const outcome = await notifyRecipient(recipientId, { reminder: true });
  revalidatePath(`/signatures/${r.requestId}`);
  if (!outcome.delivered) return { ok: false };
  await logAudit({ action: "signing.remind", summary: `Reminded ${r.name}`, entityType: "SignatureRecipient", entityId: recipientId, user });
  return { ok: true };
}

export async function voidRequest(requestId: string, reason?: string): Promise<{ ok: boolean }> {
  const user = await requirePermission("signing.manage");
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false };
  // CONDITIONAL void — only an OPEN request. An unconditional update would
  // overwrite a request a concurrent signer just completed / declined (or a
  // workflow rejection), silently discarding that terminal state.
  const voided = await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    data: { status: "voided" },
  });
  if (voided.count === 0) return { ok: false };
  await logSignEvent(requestId, { type: "voided", actor: `Denago: ${user.name}`, metadata: { reason: reason ?? "" } });
  await logAudit({ action: "signing.void", summary: `Voided “${req.title}”`, entityType: "SignatureRequest", entityId: requestId, user });
  revalidatePath("/signatures");
  revalidatePath(`/signatures/${requestId}`);
  return { ok: true };
}

/** Update recipient contact details before sending (from the dashboard). */
export async function updateRecipientContact(recipientId: string, patch: { email?: string; phone?: string }): Promise<{ ok: boolean }> {
  await requirePermission("signing.manage");
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: { select: { status: true, deletedAt: true } } } });
  if (!r) return { ok: false };
  // Don't edit recipients on a closed/trashed request.
  if (r.request.deletedAt || isRequestClosed(r.request.status)) return { ok: false };
  await prisma.signatureRecipient.update({ where: { id: recipientId }, data: { email: patch.email ?? r.email, phone: patch.phone ?? r.phone } });
  revalidatePath(`/signatures/${r.requestId}`);
  return { ok: true };
}
