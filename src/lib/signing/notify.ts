import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { logSignEvent } from "./events";

export type SigningNotificationResult = { ok: boolean; skipped?: boolean; error?: string };

async function marked(requestId: string, type: string): Promise<boolean> {
  return Boolean(await prisma.signatureEvent.findFirst({ where: { requestId, type }, select: { id: true } }));
}

/** Email the request creator that a recipient declined. Delivery failure is a
 * durable job failure, not a swallowed best-effort promise. A success/intentional
 * skip receives an immutable marker so an outbox retry never sends it twice. */
export async function notifyCreatorDeclined(
  requestId: string,
  who: string,
  reason: string,
): Promise<SigningNotificationResult> {
  const marker = "decline_notification_sent";
  if (await marked(requestId, marker)) return { ok: true, skipped: true };
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req?.createdById) {
    await logSignEvent(requestId, { type: marker, actor: "system", metadata: { skipped: "no_creator" } });
    return { ok: true, skipped: true };
  }
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) {
    await logSignEvent(requestId, { type: marker, actor: "system", metadata: { skipped: "no_creator_email" } });
    return { ok: true, skipped: true };
  }
  const result = await sendEmail({
    to: user.email,
    subject: `Signature declined: ${req.title}`,
    text: `${who} declined to sign "${req.title}".${reason ? `\n\nReason: ${reason}` : ""}\n\nOpen the signing hub to follow up.`,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "Decline notification failed" };
  await logSignEvent(requestId, { type: marker, actor: "system", channel: "email", metadata: { to: user.email } });
  return { ok: true };
}

/** Email the request creator that an approval workflow ended in rejection. */
export async function notifyCreatorRejected(requestId: string): Promise<SigningNotificationResult> {
  const marker = "rejection_notification_sent";
  if (await marked(requestId, marker)) return { ok: true, skipped: true };
  const req = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { approvals: { where: { status: "rejected" }, orderBy: { decidedAt: "desc" }, take: 1 } },
  });
  if (!req?.createdById) {
    await logSignEvent(requestId, { type: marker, actor: "system", metadata: { skipped: "no_creator" } });
    return { ok: true, skipped: true };
  }
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) {
    await logSignEvent(requestId, { type: marker, actor: "system", metadata: { skipped: "no_creator_email" } });
    return { ok: true, skipped: true };
  }
  const last = req.approvals[0];
  const result = await sendEmail({
    to: user.email,
    subject: `Approval rejected: ${req.title}`,
    text: `"${req.title}" was rejected${last ? ` at the "${last.label}" step by ${last.decidedByName ?? "an approver"}` : ""}.${last?.reason ? `\n\nReason: ${last.reason}` : ""}\n\nRevise and re-send from the signing hub.`,
  });
  if (!result.ok) return { ok: false, error: result.error ?? "Rejection notification failed" };
  await logSignEvent(requestId, { type: marker, actor: "system", channel: "email", metadata: { to: user.email } });
  return { ok: true };
}
