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
