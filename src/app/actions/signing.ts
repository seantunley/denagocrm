"use server";

import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";

// All signing now runs through the unified hub (see @/app/actions/recordSigning
// and @/lib/signing/*). The legacy token flow (enableSigning / emailSigningLink
// / revokeSigning + the /sign/[kind]/[token] pages and /api/sign/[token] routes)
// has been removed, and so has `signAsDealer` — the quote-level countersignature
// that wrote Quote.dealerSigned* directly and knew nothing about the envelope
// the customer would actually be sent. Countersigning is one act now, performed
// on the envelope by @/lib/signing/countersign, which keeps those same columns
// in step for the Print/PDF view.
//
// What remains here is the one piece that was genuinely separate all along:
// storing the signature image itself, once, against the user.

/** Store (or replace) the signed-in user's reusable signature. */
export async function saveMySignature(
  signatureDataUrl: string,
): Promise<{ ok?: boolean; error?: string }> {
  const user = await requireUser();
  if (!signatureDataUrl.startsWith("data:image/png;base64,") || signatureDataUrl.length > 400_000) {
    return { error: "Invalid signature image." };
  }
  const buf = Buffer.from(signatureDataUrl.split(",")[1], "base64");
  const ref = await saveFile(buf, `dealer-signature-${user.id}.png`, "image/png");
  await prisma.user.update({ where: { id: user.id }, data: { drawnSignatureRef: ref } });
  await logAudit({
    action: "user.signature_saved",
    summary: `${user.name} saved a reusable signature`,
    entityType: "User",
    entityId: user.id,
    user,
  });
  return { ok: true };
}
