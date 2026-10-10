import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import { recordView } from "@/lib/signing/events";
import { canAccessSignatureRequest } from "@/lib/signing/access";
import { isRequestClosed } from "@/lib/signing/status";
import { usableCapability } from "@/lib/signing/tokenVault";
import { mintInPersonPass } from "@/lib/signing/inPerson";
import { customerBrand } from "@/lib/loginBrand";
import { SignSurface } from "@/app/signing/[token]/SignSurface";
import { SigningShell, SigningMessage } from "@/app/signing/[token]/SigningShell";

export const dynamic = "force-dynamic";

const backLink: React.CSSProperties = { fontSize: 12, color: "#94a3b8", textDecoration: "underline" };

/**
 * In-person signing: a member of staff opens this on their device and hands it
 * to the signer.
 *
 * Three things this screen has to get right, and used to get wrong:
 *
 *   - It hands the signing surface the RAW link. The recipient row stores a
 *     digest, and a surface given the digest posts to a link the route hashes
 *     again and cannot find — the signer filled everything in and met "Not
 *     found" (every in-person attempt from 2026-08-06 on).
 *   - It sits outside the CRM's shell (see the (handover) layout).
 *   - It asks for no one-time code. The member of staff is the check: they get a
 *     short-lived pass naming this signer and themselves (lib/signing/inPerson.ts),
 *     and the signature is recorded as witnessed by them.
 */
export default async function InPersonSign({ params }: { params: Promise<{ id: string; recipientId: string }> }) {
  const user = await requirePermission("signing.manage");
  const { id, recipientId } = await params;
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    include: { request: { include: { fields: true, recipients: { orderBy: { order: "asc" } } } } },
  });
  if (!recipient || recipient.requestId !== id || !recipient.tenantId) notFound();
  const req = recipient.request;
  // signing.manage says "may run signing"; this says "on THIS record". A pass
  // and a working link are about to be issued for it.
  if (req.deletedAt || !(await canAccessSignatureRequest(user, req))) notFound();

  const brand = await customerBrand(recipient.tenantId);
  const back = `/signatures/${id}`;
  const toRequest = <div style={{ marginTop: 16 }}><Link href={back} style={backLink}>← Back to the request</Link></div>;
  const stop = (title: string, body: string) => <SigningMessage title={title} body={body} brand={brand}>{toRequest}</SigningMessage>;

  if (isRequestClosed(req.status)) return stop("Nothing to sign", "This signing request is closed, so it can no longer be signed.");
  if (recipient.status === "signed") return stop("Already signed", `${recipient.name} has already signed this document.`);
  if (recipient.status === "declined") return stop("Declined", `${recipient.name} declined this document.`);
  if (recipient.role === "viewer") return stop("View only", `${recipient.name} was added to view this document and does not sign it.`);
  // Not their turn. A workflow says so by which node it is sitting on — an
  // approval that is still pending, or another signer's step — and a plain
  // sequential request by who has not signed yet.
  if (req.workflowGraphJson && req.currentNodeId !== recipient.nodeId) {
    return stop("Not their turn yet", `This document is waiting on an earlier step before ${recipient.name} can sign.`);
  }
  if (req.ordering === "sequential") {
    const waitingOn = req.recipients.find((r) => r.order < recipient.order && r.role !== "viewer" && r.status !== "signed");
    if (waitingOn) return stop("Not their turn yet", `${waitingOn.name} signs before ${recipient.name}.`);
  }

  // The link the signing surface submits to. Revealed from the stored
  // ciphertext, or rotated when that cannot be read — never the digest column.
  const link = await usableCapability("signatureRecipient", recipient.id, recipient.tokenCiphertext, recipient.token);
  if (!link) return stop("Could not open the document", "A signing link could not be prepared. Go back to the request and send it again.");
  const pass = mintInPersonPass(recipient.id, recipient.tenantId, { userId: user.id, name: user.name });

  await recordView(recipient.id, req.id, recipient.name);
  const [sheets, stamps] = await Promise.all([renderRequestSigningSheets(req), signedFieldStamps(req.id, recipient.id)]);
  const myFields = req.fields
    .filter((f) => f.recipientId === recipient.id || f.recipientId === null)
    .map((f) => ({ id: f.id, kind: f.kind, label: f.label, required: f.required, page: f.page, x: f.x, y: f.y, width: f.width, height: f.height }));

  return (
    <SigningShell brand={brand}>
      <div style={{ width: "100%", maxWidth: 900, display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14, fontSize: 12, color: "#64748b" }}>
        <span>Signing in person with {user.name}</span>
        <Link href={back} style={backLink}>Staff: back to the request</Link>
      </div>
      <SignSurface
        token={link}
        title={req.title}
        recipientName={recipient.name}
        sheets={sheets}
        fields={myFields}
        stamps={stamps}
        senderName={brand.branded ? brand.displayName : undefined}
        inPerson={{ pass, staffName: user.name, doneHref: back }}
      />
    </SigningShell>
  );
}
