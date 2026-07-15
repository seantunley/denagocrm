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
import { advanceWorkflow } from "@/lib/signflow/runtime";

/**
 * Record-level entry points into the unified signing hub. These sit on the quote /
 * job-card pages and replace the legacy `/sign/[kind]/[token]` issuance — the hub
 * now owns the whole lifecycle (send → sign → seal → accept the quote / win the lead).
 */

type Kind = "quote" | "jobcard";
type Result = { ok: boolean; requestId?: string; error?: string; notified?: number; signFirstUrl?: string; modal?: boolean };

function recordPath(kind: Kind, id: string): string {
  return kind === "quote" ? `/quotes/${id}` : `/jobcards/${id}`;
}

/** Create + send a signing request for a quote / job card via the hub. */
export async function startRecordSigning(kind: Kind, id: string, workflowId?: string | null): Promise<Result> {
  const user = await requireCrmOrWorkshop();
  const quoteId = kind === "quote" ? id : null;
  const jobCardId = kind === "jobcard" ? id : null;

  // Never issue a duplicate — an open request already governs this record.
  const existing = await activeRecordRequest({ quoteId, jobCardId });
  if (existing && existing.status !== "completed" && existing.status !== "declined") {
    return { ok: true, requestId: existing.requestId };
  }

  // Pre-send gates. (Denago's countersignature is now captured through the hub as
  // the first co-signer, so no separate pad gate is required.)
  let sendLeadId: string | null = null;
  if (kind === "quote") {
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote) return { ok: false, error: "Quote not found." };
    if (quote.signedAt) return { ok: false, error: "This quote has already been signed." };
    if (quoteExpired(quote.validUntil)) return { ok: false, error: "This quote has expired — issue an updated quote first." };
    sendLeadId = quote.leadId;
  } else {
    const jc = await prisma.jobCard.findUnique({ where: { id } });
    if (!jc) return { ok: false, error: "Job card not found." };
    if (jc.signedAt) return { ok: false, error: "This job card has already been signed." };
  }

  const env = await resolveEnvelope({ quoteId, jobCardId, workflowId, signer: { name: user.name, email: user.email } });
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
    ordering: env.ordering,
    createdById: user.id,
  });

  // Attach the customer's phone (for WhatsApp) to the recipient carrying their email.
  if (env.customerPhone && env.customerEmail) {
    const cust = await prisma.signatureRecipient.findFirst({ where: { requestId: created.id, email: env.customerEmail, role: { not: "viewer" } } });
    if (cust && !cust.phone) await prisma.signatureRecipient.update({ where: { id: cust.id }, data: { phone: env.customerPhone } });
  }

  await logAudit({ action: "signing.send", summary: `Sent “${env.title}” (${env.refLabel}) for signing`, contactId: env.contactId, leadId: sendLeadId, entityType: "SignatureRequest", entityId: created.id, user });
  revalidatePath(recordPath(kind, id));

  // Approval workflow: freeze the graph, link each doc-signer recipient to its
  // node, and start the interpreter — which materialises + notifies the FIRST
  // internal step and gates the customer until the whole internal chain is done.
  if (env.frozen && env.signers) {
    const recips = await prisma.signatureRecipient.findMany({ where: { requestId: created.id }, orderBy: { order: "asc" } });
    for (let i = 0; i < env.signers.length && i < recips.length; i++) {
      await prisma.signatureRecipient.update({ where: { id: recips[i].id }, data: { nodeId: env.signers[i].nodeId } });
    }
    await prisma.signatureRequest.update({ where: { id: created.id }, data: { workflowGraphJson: env.frozen as object, currentNodeId: null } });
    await advanceWorkflow(created.id);
    // If the first internal step is a signer (usually the Denago rep = the sender),
    // pop them straight into signing in-context; if it's someone else's approval, the hub.
    const after = await prisma.signatureRequest.findUnique({ where: { id: created.id }, select: { currentNodeId: true } });
    const curNode = after?.currentNodeId ? env.frozen.graph.nodes[after.currentNodeId] : undefined;
    if (curNode?.type === "signer") {
      const rec = await prisma.signatureRecipient.findFirst({ where: { requestId: created.id, nodeId: curNode.id } });
      if (rec) return { ok: true, requestId: created.id, signFirstUrl: `/signatures/${created.id}/sign/${rec.id}`, modal: true };
    }
    return { ok: true, requestId: created.id, signFirstUrl: `/signatures/${created.id}` };
  }

  // Workflow-driven send (no approvals/branches): static chain — route the owner to
  // the hub to review recipients, fill any "choose at send" contacts, and dispatch.
  if (env.signers) {
    return { ok: true, requestId: created.id, signFirstUrl: `/signatures/${created.id}` };
  }

  // Co-sign quote: Denago signs first (in-person, through the hub). The customer is
  // notified automatically once Denago has signed (sequential advance). Route the
  // Denago rep straight to their signing surface.
  if (env.cosign) {
    const denago = await prisma.signatureRecipient.findFirst({ where: { requestId: created.id, order: 0 } });
    return { ok: true, requestId: created.id, signFirstUrl: denago ? `/signatures/${created.id}/sign/${denago.id}` : undefined, modal: true };
  }

  // Single-signer flow (job cards, assigned templates): dispatch to the customer now.
  const { notified } = await dispatchRequest(created.id);
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
