"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCrmOrWorkshop } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { saveFile } from "@/lib/storage";
import { quoteExpired } from "@/lib/quoteExpiry";
import { resolveEnvelope } from "@/lib/signing/autoEnvelope";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { createSignatureRequestFromDoc } from "@/lib/signing/service";
import { dispatchRequest } from "@/lib/signing/dispatch";
import { logSignEvent } from "@/lib/signing/events";
import { activeRecordRequest } from "@/lib/signing/record";

/**
 * Record-level entry points into the unified signing hub. These sit on the quote /
 * job-card pages and replace the legacy `/sign/[kind]/[token]` issuance — the hub
 * now owns the whole lifecycle (send → sign → seal → accept the quote / win the lead).
 */

type Kind = "quote" | "jobcard";
type Result = { ok: boolean; requestId?: string; error?: string; notified?: number };

function recordPath(kind: Kind, id: string): string {
  return kind === "quote" ? `/quotes/${id}` : `/jobcards/${id}`;
}

/** Create + send a signing request for a quote / job card via the hub. */
export async function startRecordSigning(kind: Kind, id: string): Promise<Result> {
  const user = await requireCrmOrWorkshop();
  const quoteId = kind === "quote" ? id : null;
  const jobCardId = kind === "jobcard" ? id : null;

  // Never issue a duplicate — an open request already governs this record.
  const existing = await activeRecordRequest({ quoteId, jobCardId });
  if (existing && existing.status !== "completed" && existing.status !== "declined") {
    return { ok: true, requestId: existing.requestId };
  }

  // Pre-send gates (parity with the legacy flow).
  if (kind === "quote") {
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote) return { ok: false, error: "Quote not found." };
    if (quote.signedAt) return { ok: false, error: "This quote has already been signed." };
    if (!quote.dealerSignedAt) return { ok: false, error: "Countersign the quote for Denago first, then send it." };
    if (quoteExpired(quote.validUntil)) return { ok: false, error: "This quote has expired — issue an updated quote first." };
  } else {
    const jc = await prisma.jobCard.findUnique({ where: { id } });
    if (!jc) return { ok: false, error: "Job card not found." };
    if (jc.signedAt) return { ok: false, error: "This job card has already been signed." };
  }

  const env = await resolveEnvelope({ quoteId, jobCardId });
  if (!env) return { ok: false, error: "Could not prepare the document." };

  const pdf = await renderEnvelopePdf(env.doc, quoteId, jobCardId);
  const storedName = await saveFile(pdf, `${env.title}.pdf`, "application/pdf");
  const document = await prisma.document.create({
    data: {
      fileName: `${env.title}.pdf`, storedName, mimeType: "application/pdf", sizeBytes: pdf.length,
      quoteId, jobCardId, contactId: env.contactId, tag: "for-signing", uploadedById: user.id,
    },
  });

  const created = await createSignatureRequestFromDoc({
    doc: env.doc,
    title: env.title,
    unsignedPdfRef: storedName,
    source: { documentId: document.id, quoteId, jobCardId, contactId: env.contactId },
    createdById: user.id,
  });

  // Give the (single) synthesised signer a phone so WhatsApp can reach them.
  if (env.customerPhone) {
    const signers = await prisma.signatureRecipient.findMany({ where: { requestId: created.id, role: { not: "viewer" } } });
    if (signers.length === 1 && !signers[0].phone) {
      await prisma.signatureRecipient.update({ where: { id: signers[0].id }, data: { phone: env.customerPhone } });
    }
  }

  const { notified } = await dispatchRequest(created.id);
  await logAudit({ action: "signing.send", summary: `Sent “${env.title}” (${env.refLabel}) for signing`, entityType: "SignatureRequest", entityId: created.id, user });

  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: created.id, notified };
}

/** Re-notify the outstanding signer(s) of the record's active request. */
export async function resendRecordSigning(kind: Kind, id: string): Promise<Result> {
  const user = await requireCrmOrWorkshop();
  const state = await activeRecordRequest({ quoteId: kind === "quote" ? id : null, jobCardId: kind === "jobcard" ? id : null });
  if (!state || state.status === "completed") return { ok: false, error: "No active request to resend." };
  const { notified } = await dispatchRequest(state.requestId);
  await logAudit({ action: "signing.remind", summary: `Resent “${state.title}” for signing`, entityType: "SignatureRequest", entityId: state.requestId, user });
  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: state.requestId, notified };
}

/** Void the record's active request (link stops working, record unlocks). */
export async function voidRecordSigning(kind: Kind, id: string): Promise<Result> {
  const user = await requireCrmOrWorkshop();
  const state = await activeRecordRequest({ quoteId: kind === "quote" ? id : null, jobCardId: kind === "jobcard" ? id : null });
  if (!state) return { ok: false, error: "No active request." };
  await prisma.signatureRequest.update({ where: { id: state.requestId }, data: { status: "voided" } });
  await logSignEvent(state.requestId, { type: "voided", actor: `Denago: ${user.name}`, metadata: { via: "record" } });
  await logAudit({ action: "signing.void", summary: `Voided signing for “${state.title}”`, entityType: "SignatureRequest", entityId: state.requestId, user });
  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: state.requestId };
}
