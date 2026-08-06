import "server-only";
import { basePrisma, prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent, buildSignEvent } from "./events";
import { isRequestClosed } from "./status";
import { usableCapability } from "./tokenVault";
import { advanceWorkflow } from "@/lib/signflow/runtime";
import { resolveTenantActor, resolveTenantMemberUser } from "@/lib/tenantActor";
import { tenantEnforcing } from "@/lib/tenantEnforcement";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";

export function approvalUrl(token: string): string {
  return `${BASE}/approvals/${token}`;
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
export async function notifyApprover(stepId: string): Promise<ApprovalDeliveryResult> {
  const step = await prisma.approvalStep.findUnique({
    where: { id: stepId },
    include: { request: true },
  });
  if (!step || !step.tenantId) return { ok: false, error: "Approval step not found or has no tenant owner" };
  if (isRequestClosed(step.request.status) || step.status !== "pending") return { ok: true, skipped: true };
  if (await approvalAlreadySent(step.tenantId, step.requestId, step.id)) return { ok: true, skipped: true };

  const who = await resolveApprover(step);
  if (!who.email) return { ok: false, error: `No deliverable email for approval “${step.label}”` };

  // `step.token` is a DIGEST. Putting it in the URL would send a link that the
  // route hashes again and therefore never resolves — a dead link in every
  // approval email. The raw capability is recovered from its ciphertext, and if
  // that cannot be read (no key when the row was written, or a rotated key) a
  // fresh capability is minted rather than sending something unusable.
  const raw = await usableCapability("approvalStep", step.id, step.tokenCiphertext);
  if (!raw) return { ok: false, error: `Could not prepare an approval link for “${step.label}”` };
  const result = await sendEmail({
    to: who.email,
    subject: `Approval needed: ${step.request.title}`,
    text: `Hi ${who.name},\n\n"${step.request.title}" needs your approval (${step.label}).\n\nReview and approve or reject here:\n${approvalUrl(raw)}\n\nDenago Cape Town`,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "Approval email failed" };

  await logSignEvent(step.requestId, {
    type: "approval_sent",
    actor: "system",
    channel: "email",
    metadata: { to: who.email, label: step.label, stepId: step.id },
  });
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
