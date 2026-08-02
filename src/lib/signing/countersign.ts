import "server-only";
import { prisma } from "@/lib/db";
// reqMeta only: the signing events are written on the transaction client now,
// so logSignEvent (which uses its own) would put them outside the commit —
// which is the bug this fixed.
import { reqMeta } from "./events";
import { isRequestClosed } from "./status";

/**
 * Denago's own countersignature, applied server-side from the signer's saved
 * signature.
 *
 * This is the SAME write the public signing API performs — recipient claimed,
 * field values + per-recipient responses recorded together under a row lock —
 * minus the two things that only make sense for a customer on a link: the
 * consent capture (the staff member is authenticated, and the click IS the
 * act), and the dispatch that follows.
 *
 * Deliberately does NOT call advanceAfterSignature(). On a sequential envelope
 * that helper immediately emails the next signer, which is exactly what made
 * the old flow feel automatic-but-uncontrollable: the quote left for the
 * customer the instant Denago signed, with nothing shown in between. The caller
 * sends it explicitly once the countersigned document has been reviewed, which
 * is why the request is left in "draft" — the state dispatchRequest() claims.
 */
export async function countersignWithSavedSignature(opts: {
  requestId: string;
  recipientId: string;
  signatureRef: string;
  signedName: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { requestId, recipientId, signatureRef, signedName } = opts;

  const recipient = await prisma.signatureRecipient.findUnique({
    where: { id: recipientId },
    include: { request: true },
  });
  if (!recipient || recipient.requestId !== requestId) {
    return { ok: false, error: "That signature request could not be found." };
  }
  if (recipient.status === "signed") return { ok: true };
  if (recipient.status === "declined") return { ok: false, error: "This document was declined." };
  if (recipient.role === "viewer") return { ok: false, error: "That recipient cannot sign." };
  if (recipient.request.deletedAt || isRequestClosed(recipient.request.status)) {
    return { ok: false, error: "This document can no longer be signed." };
  }

  // Assigned AND shared fields. A field with recipientId null is fillable by
  // EVERY signer — that is how the public sign route scopes them — so loading
  // only the assigned ones let this mark Denago signed while a required shared
  // consent tick or text box sat empty, which the customer's own submission
  // would then be blocked on.
  const fields = await prisma.signatureField.findMany({
    where: { requestId, OR: [{ recipientId }, { recipientId: null }] },
  });
  // A field this signer cannot answer from a stored signature (a text box, a
  // consent tick) must not be auto-filled — nobody read it. Bail rather than
  // put words in the signer's mouth; the in-person surface still handles it.
  const today = new Date().toISOString().slice(0, 10);
  const values: { id: string; value: string; kind: string; shared: boolean }[] = [];
  for (const field of fields) {
    const shared = field.recipientId === null;
    if (field.kind === "signature" || field.kind === "initials" || field.kind === "stamp") {
      values.push({ id: field.id, value: signatureRef, kind: field.kind, shared });
    } else if (field.kind === "date") {
      values.push({ id: field.id, value: today, kind: field.kind, shared });
    } else if (field.required) {
      return {
        ok: false,
        error: `“${field.label || field.kind}” needs completing by hand — open the document to sign it.`,
      };
    }
  }
  if (values.length === 0) {
    return { ok: false, error: "There is nothing for Denago to sign on this document." };
  }

  const meta = await reqMeta();
  const filledAt = new Date();

  const claimed = await prisma.$transaction(async (tx) => {
    // Same lock the public sign route takes, in the same order — a countersign
    // racing a void must serialize behind it, not straddle it.
    const rows = await tx.$queryRaw<{ status: string; deletedAt: Date | null }[]>`
      SELECT "status", "deletedAt" FROM "SignatureRequest" WHERE "id" = ${requestId} FOR UPDATE`;
    const row = rows[0];
    if (!row || row.deletedAt || isRequestClosed(row.status)) return false;

    const claim = await tx.signatureRecipient.updateMany({
      where: { id: recipientId, status: { notIn: ["signed", "declined"] } },
      data: {
        status: "signed",
        signedAt: new Date(),
        signedName,
        signerIp: meta.ip,
        signerUserAgent: meta.ua,
        signatureRef,
      },
    });
    if (claim.count === 0) return false;

    for (const value of values) {
      await tx.signatureFieldResponse.upsert({
        where: { fieldId_recipientId: { fieldId: value.id, recipientId } },
        create: { fieldId: value.id, recipientId, value: value.value, filledAt, tenantId: recipient.tenantId },
        update: { value: value.value, filledAt },
      });
      // SignatureField.value is the single value the sealed PDF stamps at the
      // field's one placed position. On a shared field two signers can race for
      // it, so claim first-write-wins and leave an earlier signer's answer
      // standing — the same rule the public sign route applies. Each signer's
      // own answer is preserved above, one row per (field, recipient).
      if (value.shared) {
        await tx.signatureField.updateMany({
          where: { id: value.id, filledAt: null },
          data: { value: value.value, filledAt },
        });
      } else {
        await tx.signatureField.update({
          where: { id: value.id },
          data: { value: value.value, filledAt },
        });
      }
    }

    // The evidence and the quote's own columns commit WITH the signature, not
    // after it. They used to run post-commit, so a crash in between left a
    // recipient marked signed with no signing events and an uncountersigned
    // quote — and the retry could not repair it, because the guard at the top
    // sees status === "signed" and returns ok straight away. There is no
    // "partly signed" state worth having: either all of this is true or none
    // of it is.
    for (const value of values) {
      await tx.signatureEvent.create({
        data: {
          requestId,
          recipientId,
          type: "field_filled",
          actor: signedName,
          channel: "web",
          metadata: { kind: value.kind, via: "countersign" },
        },
      });
    }
    await tx.signatureEvent.create({
      data: {
        requestId,
        recipientId,
        type: "signed",
        actor: signedName,
        channel: "web",
        ip: meta.ip,
        userAgent: meta.ua,
        metadata: { via: "countersign" },
      },
    });

    // Keep the quote's own countersignature columns in step. They are what the
    // Print/PDF view renders (QuotePrintDoc), and they predate the signing hub —
    // writing them here is what lets the separate "sign as Denago" action go
    // away without the printed quote losing its signature.
    if (recipient.request.quoteId) {
      await tx.quote.updateMany({
        where: { id: recipient.request.quoteId, dealerSignedAt: null },
        data: { dealerSignedAt: new Date(), dealerSignedByName: signedName, dealerSignatureRef: signatureRef },
      });
    }
    return true;
  });

  if (!claimed) return { ok: false, error: "This document can no longer be countersigned." };
  return { ok: true };
}
