import "server-only";
import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { decryptSignToken, newSignCapability } from "./tokens";
import { logSignEvent } from "./events";
import { isRequestClosed } from "./status";
import type { SigningOutboxJob } from "./outbox";
import { resolveApprover } from "./approverResolution";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";
export const approvalUrl = (raw: string) => `${BASE}/approvals/${raw}`;

async function rawApprovalToken(stepId: string): Promise<string> {
  const rows = await basePrisma.$queryRaw<Array<{ tokenCiphertext: string | null }>>(Prisma.sql`
    SELECT "tokenCiphertext" FROM "ApprovalStep" WHERE id=${stepId} LIMIT 1
  `);
  if (rows[0]?.tokenCiphertext) {
    try { return decryptSignToken(rows[0].tokenCiphertext); } catch { /* rotate */ }
  }
  const capability = newSignCapability(14);
  const updated = await basePrisma.$executeRaw`
    UPDATE "ApprovalStep" SET token=${capability.digest},"tokenCiphertext"=${capability.ciphertext},
      "tokenIssuedAt"=${capability.issuedAt},"tokenExpiresAt"=${capability.expiresAt},"tokenRevokedAt"=NULL
     WHERE id=${stepId} AND status='pending'
  `;
  if (updated !== 1) throw new Error("Approval capability cannot be rotated");
  return capability.rawToken;
}

export async function performApprovalDelivery(job: SigningOutboxJob): Promise<void> {
  const stepId = String(job.payload.stepId || "");
  if (!stepId) throw new Error("Approval delivery job has no stepId");
  const step = await prisma.approvalStep.findUnique({ where: { id: stepId }, include: { request: true } });
  if (!step || step.status !== "pending" || isRequestClosed(step.request.status)) return;
  const who = await resolveApprover(step);
  if (!who.email) throw new Error("Approver has no verified email address");
  const raw = await rawApprovalToken(step.id);
  const result = await sendEmail({
    to: who.email,
    subject: `Approval needed: ${step.request.title}`,
    text: `Hi ${who.name},\n\n“${step.request.title}” needs your approval (${step.label}).\n\nSign in to the CRM and review it here:\n${approvalUrl(raw)}\n\nThe link alone cannot approve the document.\n\nDenago Cape Town`,
  });
  await logSignEvent(step.requestId, {
    type: "approval_sent", actor: "system", channel: "email",
    metadata: { toHash: who.email ? crypto.createHash("sha256").update(who.email.toLowerCase()).digest("hex") : null, label: step.label, ok: result.ok, error: result.error },
  });
  if (!result.ok) throw new Error(result.error || "Approval email failed");
}
