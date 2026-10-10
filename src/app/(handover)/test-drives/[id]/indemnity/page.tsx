import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { canAccessTestDriveBooking } from "@/lib/testDriveAccess";
import { indemnityState } from "@/lib/testDriveIndemnity";
import { customerBrand } from "@/lib/loginBrand";
import { SigningMessage } from "@/app/signing/[token]/SigningShell";
import { InPersonSigning } from "../../../InPersonSigning";

export const dynamic = "force-dynamic";

/**
 * A test drive's indemnity, on the device the driver is handed.
 *
 * Who may open it is the booking's question, not the Signatures hub's: whoever
 * may manage this test drive. They need no signing permission — the request is
 * found through the booking, so this can only ever be that booking's own
 * indemnity. The screen itself is the same one a quote is signed on in person.
 *
 * Reading this page changes nothing. The indemnity is made by the booking
 * screen's button; a reload here shows the same document.
 */
export default async function TestDriveIndemnitySign({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("activities.manage");
  const { id } = await params;
  // The same answer for "no such booking" and "not yours".
  if (!(await canAccessTestDriveBooking(user, id))) notFound();
  const booking = await prisma.testDriveBooking.findFirst({ where: { id, deletedAt: null }, select: { tenantId: true } });
  if (!booking?.tenantId) notFound();

  const back = `/test-drives/${id}`;
  const state = await indemnityState(id);
  if (state.kind !== "open") {
    const [title, body] =
      state.kind === "signed"
        ? ["Already signed", "The indemnity for this test drive has been signed."]
        : state.kind === "finishing"
          ? ["Signed", `${state.signedByName} has signed. The signed copy is being prepared.`]
          : ["Nothing to sign yet", "Go back to the test drive and choose “Sign indemnity on this device”."];
    return (
      <SigningMessage title={title} body={body} brand={await customerBrand(booking.tenantId)}>
        <div style={{ marginTop: 16 }}>
          <Link href={back} style={{ fontSize: 12, color: "#94a3b8", textDecoration: "underline" }}>← Back to the test drive</Link>
        </div>
      </SigningMessage>
    );
  }

  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: state.recipientId },
    include: { request: { include: { fields: true, recipients: { orderBy: { order: "asc" } } } } },
  });
  // The booking's workspace is the signer's, or this is not its indemnity.
  if (!recipient || recipient.tenantId !== booking.tenantId || recipient.request.deletedAt) notFound();

  return <InPersonSigning user={user} recipient={recipient} tenantId={booking.tenantId} back={back} backTo="the test drive" />;
}
