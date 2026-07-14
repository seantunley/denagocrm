import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";

/** Email the request creator that a recipient declined. */
export async function notifyCreatorDeclined(requestId: string, who: string, reason: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId } });
  if (!req?.createdById) return;
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) return;
  await sendEmail({
    to: user.email,
    subject: `Signature declined: ${req.title}`,
    text: `${who} declined to sign "${req.title}".${reason ? `\n\nReason: ${reason}` : ""}\n\nOpen the signing hub to follow up.`,
  });
}

/** Email the request creator that an approval workflow ended in rejection. */
export async function notifyCreatorRejected(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { approvals: { where: { status: "rejected" }, orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (!req?.createdById) return;
  const user = await prisma.user.findUnique({ where: { id: req.createdById }, select: { email: true } });
  if (!user?.email) return;
  const last = req.approvals[0];
  await sendEmail({
    to: user.email,
    subject: `Approval rejected: ${req.title}`,
    text: `"${req.title}" was rejected${last ? ` at the "${last.label}" step by ${last.decidedByName ?? "an approver"}` : ""}.${last?.reason ? `\n\nReason: ${last.reason}` : ""}\n\nRevise and re-send from the signing hub.`,
  });
}
