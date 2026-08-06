import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
// reqMeta only: the signing events are written on the transaction client now,
// so logSignEvent (which uses its own) would put them outside the commit —
// which is the bug this fixed.
import { reqMeta, buildSignEvent } from "./events";
import { isRequestClosed } from "./status";

/**
 * Denago's own countersignature, applied server-side from the signer's saved
 * signature. The caller is an authenticated CRM staff session, so a strict
 * envelope records `staff_session` identity evidence in the same transaction
 * instead of sending that staff member an external OTP.
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
  if (!recipient.tenantId) return { ok: false, error: "That signature request has no tenant owner." };
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
    const rows = await tx.$queryRaw<Array<{
      status: string;
      deletedAt: Date | null;
      tenantId: string;
      identityMode: string;
    }>>`
      SELECT "status", "deletedAt", "tenantId", "identityMode"
      FROM "SignatureRequest"
      WHERE "id" = ${requestId} AND "tenantId" = ${recipient.tenantId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row || row.deletedAt || isRequestClosed(row.status)) return false;

    // The database refuses a strict recipient's status transition until durable
    // identity evidence exists. Authenticated countersigning supplies that proof
    // immediately before the claim, inside the same transaction and tenant.
    if (row.identityMode !== "link") {
      const evidenceHash = crypto.createHash("sha256").update(JSON.stringify({
        requestId,
        recipientId,
        tenantId: row.tenantId,
        method: "staff_session",
        signedName,
        at: filledAt.toISOString(),
        ip: meta.ip ?? null,
        userAgent: meta.ua ?? null,
      })).digest("hex");
      await tx.$executeRaw`
        UPDATE "SignatureRecipient"
        SET "identityVerifiedAt" = ${filledAt},
            "identityMethod" = 'staff_session',
            "identityEvidenceHash" = ${evidenceHash}
        WHERE "id" = ${recipientId}
          AND "requestId" = ${requestId}
          AND "tenantId" = ${row.tenantId}
      `;
    }

    const claim = await tx.signatureRecipient.updateMany({
      where: { id: recipientId, tenantId: row.tenantId, status: { notIn: ["signed", "declined"] } },
      data: {
        status: "signed",
        signedAt: filledAt,
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
        create: { fieldId: value.id, recipientId, value: value.value, filledAt, tenantId: row.tenantId },
        update: { value: value.value, filledAt },
      });
      // SignatureField.value is the single value the sealed PDF stamps at the
      // field's one placed position. On a shared field two signers can race for
      // it, so claim first-write-wins and leave an earlier signer's answer
      // standing — the same rule the public sign route applies. Each signer's
      // own answer is preserved above, one row per (field, recipient).
      if (value.shared) {
        await tx.signatureField.updateMany({
          where: { id: value.id, tenantId: row.tenantId, filledAt: null },
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
    // after it. There is no useful "partly signed" state: either all of this is
    // durable together or none of it is.
    for (const value of values) {
      await tx.signatureEvent.create({
        data: buildSignEvent(requestId, {
          recipientId,
          type: "field_filled",
          actor: signedName,
          channel: "web",
          metadata: { kind: value.kind, via: "countersign" },
        }),
      });
    }
    await tx.signatureEvent.create({
      data: buildSignEvent(requestId, {
        recipientId,
        type: "identity_verified",
        actor: signedName,
        channel: "web",
        ip: meta.ip,
        userAgent: meta.ua,
        metadata: { mode: row.identityMode, method: row.identityMode === "link" ? "authenticated_session" : "staff_session" },
      }),
    });
    await tx.signatureEvent.create({
      data: buildSignEvent(requestId, {
        recipientId,
        type: "signed",
        actor: signedName,
        channel: "web",
        ip: meta.ip,
        userAgent: meta.ua,
        metadata: { via: "countersign" },
      }),
    });

    // Keep the quote's own countersignature columns in step. They are what the
    // Print/PDF view renders (QuotePrintDoc), and they predate the signing hub.
    if (recipient.request.quoteId) {
      await tx.quote.updateMany({
        where: { id: recipient.request.quoteId, tenantId: row.tenantId, dealerSignedAt: null },
        data: { dealerSignedAt: filledAt, dealerSignedByName: signedName, dealerSignatureRef: signatureRef },
      });
    }
    return true;
  });

  if (!claimed) return { ok: false, error: "This document can no longer be countersigned." };
  return { ok: true };
}
