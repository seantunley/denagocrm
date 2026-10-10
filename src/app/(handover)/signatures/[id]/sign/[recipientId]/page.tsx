import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { canAccessSignatureRequest } from "@/lib/signing/access";
import { InPersonSigning } from "../../../../InPersonSigning";

export const dynamic = "force-dynamic";

/**
 * In-person signing: a member of staff opens this on their device and hands it
 * to the signer. This page decides who may do that for a request from the
 * Signatures hub; the screen itself is InPersonSigning.
 */
export default async function InPersonSign({ params }: { params: Promise<{ id: string; recipientId: string }> }) {
  const user = await requirePermission("signing.manage");
  const { id, recipientId } = await params;
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    include: { request: { include: { fields: true, recipients: { orderBy: { order: "asc" } } } } },
  });
  if (!recipient || recipient.requestId !== id || !recipient.tenantId) notFound();
  // signing.manage says "may run signing"; this says "on THIS record". A pass
  // and a working link are about to be issued for it.
  if (recipient.request.deletedAt || !(await canAccessSignatureRequest(user, recipient.request))) notFound();

  return <InPersonSigning user={user} recipient={recipient} tenantId={recipient.tenantId} back={`/signatures/${id}`} backTo="the request" />;
}
