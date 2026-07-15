"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
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
  const user = await requireCrmOrWorkshop();
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
    ref = user.drawnSignatureRef;
    if (!ref) return { error: "No saved signature yet — draw one first." };
  }
  const quote = await prisma.quote.update({
    where: { id: quoteId },
    data: { dealerSignedAt: new Date(), dealerSignedByName: user.name, dealerSignatureRef: ref },
  });
  await logAudit({
    action: "quote.dealer_signed",
    summary: `Quote Q-${quote.number} countersigned for Denago by ${user.name}`,
    leadId: quote.leadId,
    contactId: quote.contactId,
    user,
  });
  revalidatePath(`/quotes/${quoteId}`);
  return { ok: true };
}
