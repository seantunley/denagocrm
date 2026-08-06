import { notFound, redirect } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { revealSigningLink } from "@/app/actions/signingLinks";

export const dynamic = "force-dynamic";

/**
 * Staff-assisted signing deliberately enters the same public signing ceremony as
 * every remote signer. This preserves the document's configured identity policy,
 * rate limits, capability checks, consent capture and evidence path instead of
 * creating a weaker internal bypass. The capability reveal is independently
 * record-authorized and audit logged; the raw value is used only for this redirect.
 */
export default async function InPersonSign({ params }: { params: Promise<{ id: string; recipientId: string }> }) {
  await requirePermission("signing.manage");
  const { id, recipientId } = await params;
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    select: { requestId: true, status: true },
  });
  if (!recipient || recipient.requestId !== id) notFound();
  if (["signed", "declined"].includes(recipient.status)) redirect(`/signatures/${id}`);

  const revealed = await revealSigningLink(recipientId);
  if (!revealed.ok || !revealed.url) redirect(`/signatures/${id}?signingLinkError=1`);
  redirect(revealed.url);
}
