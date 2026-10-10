import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent, buildSignEvent } from "./events";
import { isRequestClosed } from "./status";
import { newSignCapability, usableCapability } from "./tokenVault";
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

export type ApprovalDeliveryResult = { ok: boolean; skipped?: boolean; error?: string };

export type ApprovalActor = {
  userId?: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
  channel?: "web" | "in_person";
};

/** Resolve who should be notified for an approval step (name + email). */
export async function resolveApprover(step: {
  assigneeType: string;
  assigneeUserId: string | null;
  assigneeRole: string | null;
  assigneeName: string | null;
  assigneeEmail: string | null;
}): Promise<{ name: string; email: string | null }> {
  if (step.assigneeType === "staff") {
    const user = step.assigneeUserId ? await resolveTenantMemberUser(step.assigneeUserId) : null;
    if (user) return { name: user.name, email: user.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  if (step.assigneeType === "owner") {
    const user = await resolveTenantActor({ ownerOnly: true });
    if (user) return { name: user.name, email: user.email };
    if (tenantEnforcing()) return { name: step.assigneeName || "Approver", email: null };
  }
  return { name: step.assigneeName || step.assigneeRole || "Approver", email: step.assigneeEmail };
}

/**
 * Best-effort duplicate suppression, not a delivery guarantee.
 *
 * The worker is the only sender and retries on failure, so delivery is
 * at-least-once: a send that succeeds and whose evidence write then fails will
 * be retried and may arrive twice. That is the right side of the trade — a
 * duplicate approval request is an annoyance, a missing one blocks a contract
 * and nobody finds out.
 */
async function approvalAlreadySent(tenantId: string, requestId: string, stepId: string): Promise<boolean> {
  const rows = await basePrisma.$queryRaw<Array<{ found: boolean }>>`
    SELECT EXISTS(
      SELECT 1 FROM "SignatureEvent"
      WHERE "tenantId" = ${tenantId}
        AND "requestId" = ${requestId}
        AND "type" = 'approval_sent'
        AND "metadata"->>'stepId' = ${stepId}
    ) AS "found"
  `;
  return Boolean(rows[0]?.found);
}

/**
 * Email the approver a review link. The ApprovalStep INSERT already committed a
 * transition-queue job, so this function is idempotent and reports delivery
 * truthfully. `approval_sent` means SMTP accepted the message, never merely that
 * an attempt was made.
 */
export async function notifyApprover(
  stepId: string,
  /**
   * `again` is a person asking for the link to be sent once more — the approver
   * lost it, or it was just handed to someone else. It skips the duplicate
   * check, which exists to stop the WORKER repeating itself, not a person.
   */
  opts: { again?: { by: string } } = {},
): Promise<ApprovalDeliveryResult> {
  const step = await prisma.approvalStep.findUnique({
    where: { id: stepId },
    include: { request: true },
  });
  if (!step || !step.tenantId) return { ok: false, error: "Approval step not found or has no tenant owner" };
  if (isRequestClosed(step.request.status) || step.status !== "pending") return { ok: true, skipped: true };
  if (!opts.again && (await approvalAlreadySent(step.tenantId, step.requestId, step.id))) return { ok: true, skipped: true };

  const who = await resolveApprover(step);
  if (!who.email) return { ok: false, error: `No deliverable email for approval “${step.label}”` };

  // `step.token` is a DIGEST. Putting it in the URL would send a link that the
  // route hashes again and therefore never resolves — a dead link in every
  // approval email. The raw capability is recovered from its ciphertext, and if
  // that cannot be read (no key when the row was written, or a rotated key) a
  // fresh capability is minted rather than sending something unusable.
  const raw = await usableCapability("approvalStep", step.id, step.tokenCiphertext, step.token);
  if (!raw) return { ok: false, error: `Could not prepare an approval link for “${step.label}”` };

  // The workspace this request belongs to — its own domain for the link, and its
  // own name at the foot of the mail. This said "Denago Cape Town" to every
  // tenant's approvers, on a mail asking them to approve their own document.
  const [origin, brand] = await Promise.all([
    tenantOrigin(step.request.tenantId),
    brandForTenant(step.request.tenantId).catch(() => DEFAULT_BRAND),
  ]);

  const result = await sendEmail({
    to: who.email,
    subject: `Approval needed: ${step.request.title}`,
    text: `Hi ${who.name},

"${step.request.title}" needs your approval (${step.label}).

Review and approve or reject here:
${approvalUrl(raw, origin)}

${brand.displayName}`,
  });
  // A failure is REPORTED, so the worker retries. Nothing is marked delivered
  // that was not: `approval_sent` is written only below, after SMTP accepted.
  if (!result.ok) return { ok: false, error: result.error ?? "Approval email failed" };

  await logSignEvent(step.requestId, {
    type: "approval_sent",
    actor: opts.again?.by ?? "system",
    channel: "email",
    metadata: { to: who.email, label: step.label, stepId: step.id, ...(opts.again ? { again: true } : {}) },
  });
  return { ok: true };
}

/** A person may ask for the link again, but not hold the button down. */
const RESEND_COOLDOWN_MS = 60 * 1000;

/** When this step's link was last emailed, or null if it never was. */
async function lastApprovalSentAt(tenantId: string, requestId: string, stepId: string): Promise<Date | null> {
  const rows = await basePrisma.$queryRaw<Array<{ at: Date | null }>>`
    SELECT MAX("createdAt") AS "at" FROM "SignatureEvent"
    WHERE "tenantId" = ${tenantId}
      AND "requestId" = ${requestId}
      AND "type" = 'approval_sent'
      AND "metadata"->>'stepId' = ${stepId}
  `;
  return rows[0]?.at ?? null;
}

/**
 * Send a waiting approver their link again.
 *
 * The approval email used to be the only way in for an approver who is not
 * signed in to the CRM, and it could be sent exactly once: one lost in a spam
 * folder left the document parked behind a gate nobody could re-open.
 */
export async function resendApproval(stepId: string, by: string): Promise<{ ok: boolean; error?: string; to?: string }> {
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: { select: { status: true } } } });
  if (!step || !step.tenantId) return { ok: false, error: "That approval is no longer there." };
  if (step.status !== "pending" || isRequestClosed(step.request.status)) return { ok: false, error: "That approval has already been decided, or its request is closed." };
  const last = await lastApprovalSentAt(step.tenantId, step.requestId, step.id);
  if (last && Date.now() - last.getTime() < RESEND_COOLDOWN_MS) {
    return { ok: false, error: "It was sent a moment ago — give it a minute before sending again." };
  }
  const who = await resolveApprover(step);
  const sent = await notifyApprover(step.id, { again: { by } });
  if (!sent.ok) return { ok: false, error: sent.error ?? "The email could not be sent." };
  return { ok: true, to: who.name };
}

/**
 * Hand a waiting approval to another member of staff.
 *
 * The step keeps its place in the workflow; only who decides it changes. The
 * link already sent is REPLACED, not shared: the first approver's link stops
 * working the moment the new one exists, so being taken off a decision takes
 * you off it. The swap is conditional on the step still being pending, so a
 * decision made a moment earlier is never overwritten by a reassignment.
 */
export async function reassignApproval(
  stepId: string,
  to: { id: string; name: string; email: string | null },
  by: string,
): Promise<{ ok: boolean; error?: string }> {
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: { select: { status: true } } } });
  if (!step || !step.tenantId) return { ok: false, error: "That approval is no longer there." };
  if (step.status !== "pending" || isRequestClosed(step.request.status)) return { ok: false, error: "That approval has already been decided, or its request is closed." };
  if (step.assigneeType === "staff" && step.assigneeUserId === to.id) return { ok: false, error: `${to.name} already has this approval.` };
  if (!to.email) return { ok: false, error: `${to.name} has no email address to send the approval to.` };

  const before = await resolveApprover(step);
  const capability = newSignCapability();
  const moved = await prisma.approvalStep.updateMany({
    where: { id: step.id, tenantId: step.tenantId, status: "pending" },
    data: {
      assigneeType: "staff",
      assigneeUserId: to.id,
      assigneeRole: null,
      assigneeName: to.name,
      assigneeEmail: to.email,
      token: capability.digest,
      tokenCiphertext: capability.ciphertext,
    },
  });
  if (moved.count !== 1) return { ok: false, error: "That approval was decided while you were choosing." };

  await logSignEvent(step.requestId, {
    type: "approval_reassigned",
    actor: by,
    metadata: { stepId: step.id, label: step.label, from: before.name, to: to.name },
  });
  const sent = await notifyApprover(step.id, { again: { by } });
  // The hand-over itself has happened; say so, and say the email did not go.
  if (!sent.ok) return { ok: false, error: `Reassigned to ${to.name}, but the email could not be sent: ${sent.error ?? "unknown error"}. Use Send again.` };
  return { ok: true };
}

/** Whether a user is allowed to act on this approval step from inside the app. */
export function canActOnStep(
  step: { assigneeType: string; assigneeUserId: string | null },
  user: { id: string; role: string },
): boolean {
  if (user.role === "owner") return true;
  if (step.assigneeType === "staff") return step.assigneeUserId === user.id;
  return false;
}

type LockedStep = {
  id: string;
  tenantId: string;
  requestId: string;
  status: string;
  label: string;
};

async function decideStep(
  stepId: string,
  decision: "approved" | "rejected",
  by: ApprovalActor,
  reason = "",
): Promise<{ ok: boolean; error?: string }> {
  const reference = await prisma.approvalStep.findUnique({
    where: { id: stepId },
    select: { requestId: true, tenantId: true },
  });
  if (!reference?.tenantId) return { ok: false, error: "This approval can no longer be actioned." };
  const decidedAt = new Date();

  const requestId = await prisma.$transaction(async (tx) => {
    const requests = await tx.$queryRaw<Array<{ status: string; deletedAt: Date | null }>>`
      SELECT "status", "deletedAt"
      FROM "SignatureRequest"
      WHERE "id" = ${reference.requestId} AND "tenantId" = ${reference.tenantId}
      FOR UPDATE
    `;
    const request = requests[0];
    if (!request || request.deletedAt || isRequestClosed(request.status)) return null;

    const steps = await tx.$queryRaw<LockedStep[]>`
      SELECT "id", "tenantId", "requestId", "status", "label"
      FROM "ApprovalStep"
      WHERE "id" = ${stepId}
        AND "requestId" = ${reference.requestId}
        AND "tenantId" = ${reference.tenantId}
      FOR UPDATE
    `;
    const step = steps[0];
    if (!step || step.status !== "pending") return null;

    const claimed = await tx.approvalStep.updateMany({
      where: { id: step.id, tenantId: step.tenantId, status: "pending" },
      data: {
        status: decision,
        decidedByUserId: by.userId ?? null,
        decidedByName: by.name,
        decidedAt,
        ...(decision === "rejected" ? { reason: reason.slice(0, 500) } : {}),
      },
    });
    if (claimed.count !== 1) return null;

    await tx.signatureEvent.create({
      data: buildSignEvent(step.requestId, {
        type: decision === "approved" ? "approved" : "rejected",
        actor: by.name,
        channel: by.channel ?? "web",
        ip: by.ip ?? null,
        userAgent: by.userAgent ?? null,
        metadata: {
          stepId: step.id,
          label: step.label,
          decision,
          ...(decision === "rejected" ? { reason: reason.slice(0, 500) } : {}),
          ...(by.userId ? { userId: by.userId } : {}),
        },
      }),
    });
    // ApprovalStep triggers revoke the bearer token and enqueue workflow recovery
    // in this same transaction.
    return step.requestId;
  });

  if (!requestId) return { ok: false, error: "This approval can no longer be actioned." };
  // Fast path only. The transition worker owns eventual advancement and rejection
  // notification, so a committed decision is never reported as failed.
  await advanceWorkflow(requestId).catch(() => {});
  return { ok: true };
}

export async function approveStep(
  stepId: string,
  by: ApprovalActor,
): Promise<{ ok: boolean; error?: string }> {
  return decideStep(stepId, "approved", by);
}

export async function rejectStep(
  stepId: string,
  by: ApprovalActor,
  reason: string,
): Promise<{ ok: boolean; error?: string }> {
  return decideStep(stepId, "rejected", by, reason);
}
