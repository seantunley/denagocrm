import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";

export type SigningNotificationResult = { ok: boolean; skipped?: boolean; error?: string };

/** Email the request creator that a recipient declined. Delivery failure is a
 * durable job failure, not a swallowed best-effort promise. */
export async function notifyCreatorDeclined(
  requestId: string,
  who: string,
  reason: string,
): Promise<SigningNotificationResult> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req?.createdById) return { ok: true, skipped: true };
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) return { ok: true, skipped: true };
  const result = await sendEmail({
    to: user.email,
    subject: `Signature declined: ${req.title}`,
    text: `${who} declined to sign "${req.title}".${reason ? `\n\nReason: ${reason}` : ""}\n\nOpen the signing hub to follow up.`,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Decline notification failed" };
}

/** Email the request creator that an approval workflow ended in rejection. */
export async function notifyCreatorRejected(requestId: string): Promise<SigningNotificationResult> {
  const req = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { approvals: { where: { status: "rejected" }, orderBy: { decidedAt: "desc" }, take: 1 } },
  });
  if (!req?.createdById) return { ok: true, skipped: true };
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) return { ok: true, skipped: true };
  const last = req.approvals[0];
  const result = await sendEmail({
    to: user.email,
    subject: `Approval rejected: ${req.title}`,
    text: `"${req.title}" was rejected${last ? ` at the "${last.label}" step by ${last.decidedByName ?? "an approver"}` : ""}.${last?.reason ? `\n\nReason: ${last.reason}` : ""}\n\nRevise and re-send from the signing hub.`,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error ?? "Rejection notification failed" };
}
