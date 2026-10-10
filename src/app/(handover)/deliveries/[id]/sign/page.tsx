import Link from "next/link";
import { notFound } from "next/navigation";
import { canAccessQuote, requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { deliveryNoteState } from "@/lib/deliveryNoteSigning";
import { customerBrand } from "@/lib/loginBrand";
import { SigningMessage } from "@/app/signing/[token]/SigningShell";
import { InPersonSigning } from "../../../InPersonSigning";

export const dynamic = "force-dynamic";

/**
 * The delivery note, on the device the customer is handed at handover.
 *
 * Who may open it is the delivery's question: whoever may manage deliveries and
 * may open this quote — the same two checks every step on the Deliveries board
 * makes. No signing permission is involved; the request is found through the
 * quote, so this can only ever be that delivery's own note.
 *
 * Reading this page changes nothing. The note is made by the delivery screen's
 * button; a reload here shows the same document.
 */
export default async function DeliveryNoteSign({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("deliveries.manage");
  const { id } = await params;
  // A delivery note is automotive paperwork, and one answer for "no such quote" and "not yours".
  if (!(await isModuleEnabled("automotive")) || !(await canAccessQuote(user, id))) notFound();
  const quote = await prisma.quote.findFirst({ where: { id }, select: { tenantId: true } });
  if (!quote?.tenantId) notFound();

  const back = "/deliveries";
  const state = await deliveryNoteState(id);
  if (state.kind !== "open") {
    const [title, body] =
      state.kind === "none"
        ? ["Nothing to sign yet", "Go back to the delivery and choose “Customer signs on this device”."]
        : ["Signed", `${state.signedByName} has signed the delivery note. Go back to the delivery to complete it.`];
    return (
      <SigningMessage title={title} body={body} brand={await customerBrand(quote.tenantId)}>
        <div style={{ marginTop: 16 }}>
          <Link href={back} style={{ fontSize: 12, color: "#94a3b8", textDecoration: "underline" }}>← Back to the delivery</Link>
        </div>
      </SigningMessage>
    );
  }

  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: state.recipientId },
    include: { request: { include: { fields: true, recipients: { orderBy: { order: "asc" } } } } },
  });
  // The quote's workspace is the signer's, or this is not its delivery note.
  if (!recipient || recipient.tenantId !== quote.tenantId || recipient.request.deletedAt) notFound();

  return <InPersonSigning user={user} recipient={recipient} tenantId={quote.tenantId} back={back} backTo="the delivery" />;
}
