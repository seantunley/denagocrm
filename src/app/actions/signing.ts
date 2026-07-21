"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireQuoteAccess } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";

// All customer signing now runs through the unified hub (see
// @/app/actions/recordSigning and @/lib/signing/*). The legacy token flow
// (enableSigning / emailSigningLink / revokeSigning + the /sign/[kind]/[token]
// pages and /api/sign/[token] routes) has been removed. `signAsDealer` remains:
// Denago's in-person countersignature on a quote before it goes to the customer.

/** Denago countersigns a quote (required before it can go to the customer). */
export async function signAsDealer(
  quoteId: string,
  signatureDataUrl: string | null,
  saveForReuse: boolean
): Promise<{ ok?: boolean; error?: string }> {
  // Countersigning stamps Denago's signature onto a specific quote and changes
  // its state, so require access to THAT quote (not just a module) plus a
  // change-status permission. Guard the quote's state too: never countersign a
  // trashed, already-countersigned or already customer-signed quote.
  const user = await requireQuoteAccess(quoteId, "quotes.change_status");
  let ref: string | null;
  if (signatureDataUrl) {
    if (!signatureDataUrl.startsWith("data:image/png;base64,") || signatureDataUrl.length > 400_000) {
      return { error: "Invalid signature image." };
    }
    const buf = Buffer.from(signatureDataUrl.split(",")[1], "base64");
    ref = await saveFile(buf, `dealer-signature-${user.id}.png`, "image/png");
    if (saveForReuse) {
      await prisma.user.update({ where: { id: user.id }, data: { drawnSignatureRef: ref } });
    }
  } else {
    // requireQuoteAccess returns the slim permission user, so read the saved
    // signature from the DB.
    const saved = await prisma.user.findUnique({
      where: { id: user.id },
      select: { drawnSignatureRef: true },
    });
    ref = saved?.drawnSignatureRef ?? null;
    if (!ref) return { error: "No saved signature yet — draw one first." };
  }
  // Conditional claim: only the request whose predicate still matches (not
  // trashed, not already countersigned, not customer-signed, not superseded)
  // writes the signature. check-then-update let two concurrent countersigns both
  // see dealerSignedAt === null and overwrite each other.
  const claimed = await prisma.quote.updateMany({
    where: { id: quoteId, deletedAt: null, dealerSignedAt: null, signedAt: null, supersededAt: null },
    data: { dealerSignedAt: new Date(), dealerSignedByName: user.name, dealerSignatureRef: ref },
  });
  if (claimed.count !== 1) {
    return { error: "This quote can no longer be countersigned." };
  }
  const quote = await prisma.quote.findUnique({
    where: { id: quoteId },
    select: { number: true, leadId: true, contactId: true },
  });
  await logAudit({
    action: "quote.dealer_signed",
    summary: `Quote Q-${quote?.number ?? "?"} countersigned for Denago by ${user.name}`,
    leadId: quote?.leadId,
    contactId: quote?.contactId,
    user,
  });
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}
