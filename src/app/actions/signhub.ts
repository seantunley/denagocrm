"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission, requireAnyPermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { dispatchRequest, notifyRecipient, sendToRecipient } from "@/lib/signing/dispatch";
import { logSignEvent, staffActor } from "@/lib/signing/events";
import { approveStep, rejectStep, canActOnStep } from "@/lib/signing/approvals";
import { isRequestClosed } from "@/lib/signing/status";
import { voidOpenRequest } from "@/lib/signing/void";
import { nextSigner } from "@/lib/signing/nextSigner";
import { advanceWorkflow, pendingApprovalNode } from "@/lib/signflow/runtime";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { readFile } from "@/lib/storage";
import { COMPLETED_EVENT, deliverCompletionEmails } from "@/lib/signing/completionFanout";
import { exactTenantWhere } from "@/lib/signing/recoveryScope";
import {
  REQUEST_BINDING_SELECT,
  canAccessRecipient,
  canAccessSignatureRequest,
  resolveSignatureRequestAccess,
} from "@/lib/signing/access";

/** Approve or reject a pending approval step from inside the app (hub queue). */
export async function decideApproval(stepId: string, decision: "approve" | "reject", reason?: string): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    // The signing hub's own grant, not the retired crm/workshop module flag.
    // canActOnStep still restricts the decision to the assigned approver.
    const user = await requireAnyPermission("signing.view", "signing.manage");
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
  });
}

export async function sendRequest(requestId: string): Promise<{ ok: boolean; notified?: number; error?: string; message?: string }> {
  return withActingStaffScope(async () => {
    const access = await resolveSignatureRequestAccess(() =>
      prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } }),
    );
    if (!access) return { ok: false, error: "Not found" };
    const { user, request: req } = access;
    if (req.deletedAt) return { ok: false, error: "Not found" };
    if (isRequestClosed(req.status)) return { ok: false, error: "This request is closed." };
    const reachable = req.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone));
    if (reachable.length === 0) return { ok: false, error: "Add an email or phone to at least one signer first." };

    let notified: number;
    let unreachable: number;
    if (req.workflowGraphJson) {
      // A workflow decides who goes first, and it may be nobody who signs: an
      // approval gate has no recipient. Sending by recipient order from here
      // skipped the gate entirely and mailed the customer. Do what the quote's
      // own card does — reach whoever the current node is waiting on, or raise
      // the approval.
      const recipient = await nextSigner(requestId);
      if (!recipient) {
        const gate = await pendingApprovalNode(requestId);
        if (!gate) return { ok: false, error: "Nobody is waiting to sign this request." };
        if (gate.raised) return { ok: false, error: `Waiting on “${gate.label}” — the approver has already been asked.` };
        await advanceWorkflow(requestId);
        await logAudit({ action: "signing.send", summary: `Sent “${req.title}” for approval (${gate.label})`, entityType: "SignatureRequest", entityId: requestId, user });
        revalidatePath("/signatures");
        revalidatePath(`/signatures/${requestId}`);
        return { ok: true, notified: 0, message: `Sent for approval — ${gate.label}.` };
      }
      ({ notified, unreachable } = await sendToRecipient(requestId, recipient.id));
    } else {
      ({ notified, unreachable } = await dispatchRequest(requestId));
    }
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
  });
}

/**
 * RE-send an already-sent request. Unlike sendRequest (first dispatch),
 * this must pass `reminder: true` — recipients already in "sent"/"viewed"
 * are otherwise silently skipped by notifyRecipient's at-most-once
 * pending→sent claim, while dispatchRequest's `notified` count still
 * includes them, so the hub reported "Sent to N recipient(s)" when nothing
 * actually went out. Mirrors the already-correct resendRecordSigning.
 */
export async function resendRequest(requestId: string): Promise<{ ok: boolean; notified?: number; error?: string; message?: string }> {
  return withActingStaffScope(async () => {
    const access = await resolveSignatureRequestAccess(() =>
      prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } }),
    );
    if (!access) return { ok: false, error: "Not found" };
    const { user, request: req } = access;
    if (req.deletedAt) return { ok: false, error: "Not found" };
    if (req.status === "draft") return { ok: false, error: "This request hasn't been sent yet." };
    if (isRequestClosed(req.status)) return { ok: false, error: "This request is closed." };
    const reachable = req.recipients.filter((r) => r.role !== "viewer" && (r.email || r.phone));
    if (reachable.length === 0) return { ok: false, error: "Add an email or phone to at least one signer first." };

    // WHO is resent to. dispatchRequest picks its targets by recipient ORDER, and
    // a workflow pre-creates a recipient for every path — so here it could hand
    // the customer a live signing link while a manager's approval was still
    // pending, or nudge someone on a branch the document never took. A workflow
    // request is resent to whoever its current node is waiting on, and to nobody
    // when that is an approval. Same rule as the resend on the quote's own card.
    let notified: number;
    if (req.workflowGraphJson) {
      const recipient = await nextSigner(requestId);
      if (!recipient) {
        const gate = await pendingApprovalNode(requestId);
        return {
          ok: false,
          error: gate
            ? `Waiting on “${gate.label}” — nobody can sign until it is approved.`
            : "Nobody is waiting to sign this request.",
        };
      }
      notified = (await notifyRecipient(recipient.id, { reminder: true })).delivered ? 1 : 0;
    } else {
      ({ notified } = await dispatchRequest(requestId, { reminder: true }));
    }
    revalidatePath("/signatures");
    revalidatePath(`/signatures/${requestId}`);
    // Truthful reporting: a resend that reached nobody is not logged as one and
    // is not reported as "Sent to 0 recipient(s)".
    if (notified === 0) return { ok: false, notified: 0, error: "The reminder could not be delivered — check the signer's contact details." };
    await logAudit({ action: "signing.remind", summary: `Resent “${req.title}” for signing`, entityType: "SignatureRequest", entityId: requestId, user });
    return { ok: true, notified };
  });
}

/**
 * Email the sealed PDF again to every recipient who never received it (gap audit
 * #32). A completed request whose fan-out failed looked exactly like one that
 * succeeded; the recovery sweep retries a few times and then stops. This is the
 * person's way through after that. Only recipients still missing their copy are
 * sent to — `deliverCompletionEmails` skips anyone already marked delivered.
 */
export async function resendSignedCopies(requestId: string) {
  return asActionResult(async () => {
    const access = await resolveSignatureRequestAccess(() =>
      prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: true } }),
    );
    if (!access) refuse("That signing request is no longer there — refresh the page.");
    const { user, request: req } = access;
    if (req.deletedAt) refuse("That signing request is no longer there — refresh the page.");
    if (req.status !== "completed" || !req.signedPdfRef) refuse("Only a completed request has a signed copy to send.");
    let pdf: Buffer;
    try {
      pdf = await readFile(req.signedPdfRef, req.tenantId);
    } catch {
      refuse("The signed PDF can't be read from storage — contact support before resending.");
    }
    const delivery = await deliverCompletionEmails({
      requestId,
      title: req.title,
      pdf,
      recipients: req.recipients.map((r) => ({ id: r.id, name: r.name, email: r.email, completedEmailSentAt: r.completedEmailSentAt })),
      tenantWhere: exactTenantWhere(req.tenantId),
    });
    // Fully delivered now: write the marker the recovery sweep looks for, so it
    // stops considering this request stranded.
    if (delivery.ok && !(await prisma.signatureEvent.findFirst({ where: { requestId, type: COMPLETED_EVENT }, select: { id: true } }))) {
      await logSignEvent(requestId, { type: COMPLETED_EVENT, actor: await staffActor(user.name, req.tenantId) });
    }
    await logAudit({
      action: "signing.signed_copy_resent",
      summary: `Resent the signed copy of “${req.title}” — ${delivery.sent} sent${delivery.failures.length ? `, ${delivery.failures.length} still failing` : ""}`,
      entityType: "SignatureRequest",
      entityId: requestId,
      user,
    });
    revalidatePath(`/signatures/${requestId}`);
    if (!delivery.ok) refuse(`Still couldn't send to ${delivery.failures.length} recipient${delivery.failures.length === 1 ? "" : "s"} — check their email address and the mail settings.`);
    return { success: delivery.sent ? `Sent to ${delivery.sent} recipient${delivery.sent === 1 ? "" : "s"}` : "Everyone already has it" };
  });
}

export async function remindRecipient(recipientId: string): Promise<{ ok: boolean; error?: string }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("signing.manage");
    const r = await prisma.signatureRecipient.findUnique({
      where: { id: recipientId },
      include: { request: { select: { ordering: true, workflowGraphJson: true } } },
    });
    // Addressed by recipient id, so the record this ultimately touches is one hop
    // away — and that hop is where the authorization was missing. A reminder
    // re-delivers the signing link, so it must be gated like the send itself.
    if (!r || !(await canAccessRecipient(user, recipientId))) return { ok: false, error: "Not found" };
    // A reminder carries a working signing link, so it goes only to someone whose
    // turn it is. In a request signed in order — or one waiting on an approval —
    // reminding the wrong row handed them the document early.
    if (r.request.workflowGraphJson || r.request.ordering === "sequential") {
      const next = await nextSigner(r.requestId);
      if (next?.id !== r.id) {
        return { ok: false, error: next ? `${next.name} signs before ${r.name}.` : `It is not ${r.name}'s turn to sign yet.` };
      }
    }
    const outcome = await notifyRecipient(recipientId, { reminder: true });
    revalidatePath(`/signatures/${r.requestId}`);
    if (!outcome.delivered) {
      return { ok: false, error: outcome.reachable ? "The reminder could not be delivered — try again shortly." : `${r.name} has no email address or mobile number.` };
    }
    await logAudit({ action: "signing.remind", summary: `Reminded ${r.name}`, entityType: "SignatureRecipient", entityId: recipientId, user });
    return { ok: true };
  });
}

export async function voidRequest(requestId: string, reason?: string): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const access = await resolveSignatureRequestAccess(() =>
      prisma.signatureRequest.findUnique({ where: { id: requestId } }),
    );
    if (!access) return { ok: false };
    const { user, request: req } = access;
    // The one void (lib/signing/void.ts) — the same transaction the quote's own
    // card runs. This used to void the request and stop there, so the quote went
    // on saying "Sent" about a document nobody could sign any more.
    const voided = await voidOpenRequest(requestId);
    if (!voided) return { ok: false };
    await logSignEvent(requestId, { type: "voided", actor: await staffActor(user.name, req.tenantId), metadata: { reason: reason ?? "" } });
    await logAudit({ action: "signing.void", summary: `Voided “${req.title}”`, entityType: "SignatureRequest", entityId: requestId, user });
    revalidatePath("/signatures");
    revalidatePath(`/signatures/${requestId}`);
    if (voided.quoteId) {
      revalidatePath("/quotes");
      revalidatePath(`/quotes/${voided.quoteId}`);
    }
    if (voided.jobCardId) revalidatePath(`/jobcards/${voided.jobCardId}`);
    return { ok: true };
  });
}

/**
 * Update recipient contact details before sending (from the dashboard).
 *
 * The most sensitive mutation in this file: it decides WHERE a signing link is
 * delivered. Rewrite the email, resend, and the token arrives in the attacker's
 * inbox for a document they were never entitled to see — so it needs the record
 * check, and it needs to leave a trace. It previously did neither: no access
 * check beyond the capability, and no audit entry at all, so a redirected
 * recipient was invisible after the fact.
 */
export async function updateRecipientContact(recipientId: string, patch: { email?: string; phone?: string }): Promise<{ ok: boolean }> {
  return withActingStaffScope(async () => {
    const user = await requirePermission("signing.manage");
    const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: { select: { status: true, deletedAt: true, ...REQUEST_BINDING_SELECT } } } });
    if (!r) return { ok: false };
    if (!(await canAccessSignatureRequest(user, r.request))) return { ok: false };
    // Don't edit recipients on a closed/trashed request.
    if (r.request.deletedAt || isRequestClosed(r.request.status)) return { ok: false };
    const next = { email: patch.email ?? r.email, phone: patch.phone ?? r.phone };
    await prisma.signatureRecipient.update({ where: { id: recipientId }, data: next });
    if (next.email !== r.email || next.phone !== r.phone) {
      await logAudit({
        action: "signing.recipient_contact_changed",
        summary: `Changed where “${r.name}” receives their signing link`,
        entityType: "SignatureRecipient",
        entityId: recipientId,
        user,
        before: { email: r.email, phone: r.phone },
        after: next,
      });
    }
    revalidatePath(`/signatures/${r.requestId}`);
    return { ok: true };
  });
}
