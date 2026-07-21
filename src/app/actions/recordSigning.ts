"use server";

import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { requireQuoteAccess, requireJobCardAccess, type PermissionUser } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { saveFile, deleteFile } from "@/lib/storage";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "@/lib/signing/status";
import { quoteExpired } from "@/lib/quoteExpiry";
import { defaultBuilderTemplateId } from "@/lib/docbuilder/store";
import { resolveEnvelope } from "@/lib/signing/autoEnvelope";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { createSignatureRequestFromDoc } from "@/lib/signing/service";
import { dispatchRequest } from "@/lib/signing/dispatch";
import { logSignEvent } from "@/lib/signing/events";
import { activeRecordRequest } from "@/lib/signing/record";
import { advanceWorkflow, repairWorkflow } from "@/lib/signflow/runtime";

type Kind = "quote" | "jobcard";
type Result = {
  ok: boolean;
  requestId?: string;
  error?: string;
  notified?: number;
  signFirstUrl?: string;
  modal?: boolean;
};

function recordPath(kind: Kind, id: string): string {
  return kind === "quote" ? `/quotes/${id}` : `/jobcards/${id}`;
}

/**
 * Record-level authorization for signing lifecycle actions. The old module-only
 * `requireCrmOrWorkshop()` let any crm/workshop user start/resend/void signing on
 * ANY quote or job card by id. Signing changes the record's state, so require
 * access to that specific record plus a change-status/manage permission.
 */
function requireRecordSigningAccess(kind: Kind, id: string): Promise<PermissionUser> {
  return kind === "quote"
    ? requireQuoteAccess(id, "quotes.change_status")
    : requireJobCardAccess(id, "jobcards.manage");
}

/**
 * Validate that the underlying record is still in an active, signable lifecycle
 * state. Runs BEFORE any existing-request lookup so a trashed / superseded /
 * already-signed / expired record is rejected even when it still has an open
 * request attached. `findUnique` isn't soft-delete filtered and view_all access
 * is unrestricted, so these checks are explicit. Returns the quote's leadId for
 * audit attribution on success.
 */
async function checkRecordActive(
  kind: Kind,
  id: string,
): Promise<{ error: string | null; leadId: string | null; version: number | null }> {
  if (kind === "quote") {
    const quote = await prisma.quote.findUnique({ where: { id } });
    if (!quote || quote.deletedAt) return { error: "Quote not found.", leadId: null, version: null };
    if (quote.supersededAt) {
      return { error: "This quote was superseded by a revision — sign the current version.", leadId: null, version: null };
    }
    if (quote.signedAt) return { error: "This quote has already been signed.", leadId: null, version: null };
    if (quoteExpired(quote.validUntil)) {
      return { error: "This quote has expired — issue an updated quote first.", leadId: null, version: null };
    }
    return { error: null, leadId: quote.leadId, version: quote.updatedAt.getTime() };
  }
  const jobCard = await prisma.jobCard.findUnique({ where: { id } });
  if (!jobCard || jobCard.deletedAt) return { error: "Job card not found.", leadId: null, version: null };
  if (jobCard.signedAt) return { error: "This job card has already been signed.", leadId: null, version: null };
  return { error: null, leadId: null, version: jobCard.updatedAt.getTime() };
}

export async function startRecordSigning(
  kind: Kind,
  id: string,
  workflowId?: string | null,
): Promise<Result> {
  const user = await requireRecordSigningAccess(kind, id);
  const quoteId = kind === "quote" ? id : null;
  const jobCardId = kind === "jobcard" ? id : null;

  // Validate the record's lifecycle FIRST — a trashed / superseded / signed /
  // expired record must be rejected even if it still has an open request, so
  // this runs before the existing-request short-circuit below.
  const active = await checkRecordActive(kind, id);
  if (active.error) return { ok: false, error: active.error };
  const sendLeadId = active.leadId;
  const sourceVersion = active.version;

  // Cheap unlocked pre-check to short-circuit the common "already open" case, and
  // self-heal a workflow request left un-advanced by an earlier crash.
  const existing = await activeRecordRequest({ quoteId, jobCardId });
  if (existing && !isRequestClosed(existing.status)) {
    await repairWorkflow(existing.requestId);
    return { ok: true, requestId: existing.requestId };
  }

  // Quote signing uses the editable builder template. Job cards deliberately stay
  // on their current synthesised signing layout until visual parity is verified.
  const templateId =
    kind === "quote" ? await defaultBuilderTemplateId("quote") : null;
  const envelope = await resolveEnvelope({
    quoteId,
    jobCardId,
    templateId,
    workflowId,
    signer: { name: user.name, email: user.email },
  });
  if (!envelope) {
    return { ok: false, error: "Could not prepare the document." };
  }

  const pdf = await renderEnvelopePdf(envelope.doc, quoteId, jobCardId);
  const storedName = await saveFile(
    pdf,
    `${envelope.title}.pdf`,
    "application/pdf",
  );

  // The check-and-create runs in one transaction that locks the SOURCE record row
  // FOR UPDATE — the SAME mutex used by quote/job-card edits, revisions, status
  // changes and deletion — so signing start serializes with the whole lifecycle,
  // not just other signing starts. Under the lock we re-validate the record AND
  // verify it hasn't changed since the envelope was rendered (version check), so
  // we can't snapshot a stale version. The document, request, recipients, fields
  // — AND, for a workflow envelope, the frozen graph + recipient node IDs — are
  // all created together, so a crash can't leave a partial or unrecognisable
  // draft; the worst residual state (graph set, not yet advanced) self-heals.
  const isWorkflow = Boolean(envelope.frozen && envelope.signers);
  let committedRequestId: string | null = null;
  let outcome:
    | { kind: "stale" }
    | { kind: "reused"; requestId: string }
    | { kind: "created"; requestId: string } = { kind: "stale" };
  try {
    outcome = await basePrisma.$transaction(async (tx) => {
      if (quoteId) {
        await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
        const q = await tx.quote.findUnique({
          where: { id: quoteId },
          select: { deletedAt: true, signedAt: true, supersededAt: true, validUntil: true, updatedAt: true },
        });
        if (!q || q.deletedAt || q.signedAt || q.supersededAt || quoteExpired(q.validUntil) || q.updatedAt.getTime() !== sourceVersion) {
          return { kind: "stale" as const };
        }
      } else {
        await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${jobCardId} FOR UPDATE`;
        const jc = await tx.jobCard.findUnique({
          where: { id: jobCardId! },
          select: { deletedAt: true, signedAt: true, updatedAt: true },
        });
        if (!jc || jc.deletedAt || jc.signedAt || jc.updatedAt.getTime() !== sourceVersion) {
          return { kind: "stale" as const };
        }
      }
      const open = await tx.signatureRequest.findFirst({
        where: {
          ...(quoteId ? { quoteId } : { jobCardId }),
          deletedAt: null,
          status: { notIn: [...CLOSED_REQUEST_STATUSES] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (open) return { kind: "reused" as const, requestId: open.id };
      const document = await tx.document.create({
        data: {
          fileName: `${envelope.title}.pdf`,
          storedName,
          mimeType: "application/pdf",
          sizeBytes: pdf.length,
          quoteId,
          jobCardId,
          contactId: envelope.contactId,
          tag: "for-signing",
          uploadedById: user.id,
        },
      });
      const created = await createSignatureRequestFromDoc({
        doc: envelope.doc,
        title: envelope.title,
        unsignedPdfRef: storedName,
        source: {
          documentId: document.id,
          quoteId,
          jobCardId,
          contactId: envelope.contactId,
        },
        ordering: envelope.ordering,
        createdById: user.id,
        client: tx,
      });
      if (isWorkflow && envelope.frozen && envelope.signers) {
        const recipients = await tx.signatureRecipient.findMany({
          where: { requestId: created.id },
          orderBy: { order: "asc" },
        });
        for (let index = 0; index < envelope.signers.length && index < recipients.length; index += 1) {
          await tx.signatureRecipient.update({
            where: { id: recipients[index].id },
            data: { nodeId: envelope.signers[index].nodeId },
          });
        }
        await tx.signatureRequest.update({
          where: { id: created.id },
          data: { workflowGraphJson: envelope.frozen as object, currentNodeId: null },
        });
      }
      return { kind: "created" as const, requestId: created.id };
    });
    if (outcome.kind === "created") committedRequestId = outcome.requestId;
  } finally {
    // Retain the rendered (unsigned) PDF only when a request COMMITTED referencing
    // it. committedRequestId is assigned only AFTER the transaction promise
    // resolves, so a commit failure (callback returns, commit then throws) also
    // cleans the blob — no orphaned customer/commercial data.
    if (!committedRequestId) await deleteFile(storedName).catch(() => {});
  }
  if (outcome.kind === "stale") {
    return { ok: false, error: "This record changed while the signing document was being prepared — please try again." };
  }
  if (outcome.kind === "reused") {
    await repairWorkflow(outcome.requestId);
    return { ok: true, requestId: outcome.requestId };
  }
  const requestId: string = outcome.requestId;

  if (envelope.customerPhone && envelope.customerEmail) {
    const customer = await prisma.signatureRecipient.findFirst({
      where: {
        requestId,
        email: envelope.customerEmail,
        role: { not: "viewer" },
      },
    });
    if (customer && !customer.phone) {
      await prisma.signatureRecipient.update({
        where: { id: customer.id },
        data: { phone: envelope.customerPhone },
      });
    }
  }

  await logAudit({
    action: "signing.send",
    summary: `Sent “${envelope.title}” (${envelope.refLabel}) for signing`,
    contactId: envelope.contactId,
    leadId: sendLeadId,
    entityType: "SignatureRequest",
    entityId: requestId,
    user,
  });
  revalidatePath(recordPath(kind, id));

  if (isWorkflow && envelope.frozen) {
    // The graph + recipient node IDs were committed in the creation transaction;
    // advance the first node now. advanceWorkflow is idempotent, and a retry that
    // reuses an un-advanced request repairs it the same way (repairWorkflow).
    await advanceWorkflow(requestId);
    const after = await prisma.signatureRequest.findUnique({
      where: { id: requestId },
      select: { currentNodeId: true },
    });
    const currentNode = after?.currentNodeId
      ? envelope.frozen.graph.nodes[after.currentNodeId]
      : undefined;
    if (currentNode?.type === "signer") {
      const recipient = await prisma.signatureRecipient.findFirst({
        where: { requestId: requestId, nodeId: currentNode.id },
      });
      if (recipient) {
        return {
          ok: true,
          requestId: requestId,
          signFirstUrl: `/signatures/${requestId}/sign/${recipient.id}`,
          modal: true,
        };
      }
    }
    return {
      ok: true,
      requestId: requestId,
      signFirstUrl: `/signatures/${requestId}`,
    };
  }

  if (envelope.signers) {
    return {
      ok: true,
      requestId: requestId,
      signFirstUrl: `/signatures/${requestId}`,
    };
  }

  if (envelope.cosign) {
    const dealer = await prisma.signatureRecipient.findFirst({
      where: { requestId: requestId, order: 0 },
    });
    return {
      ok: true,
      requestId: requestId,
      signFirstUrl: dealer
        ? `/signatures/${requestId}/sign/${dealer.id}`
        : undefined,
      modal: true,
    };
  }

  const { notified } = await dispatchRequest(requestId);
  return { ok: true, requestId: requestId, notified };
}

export async function resendRecordSigning(
  kind: Kind,
  id: string,
): Promise<Result> {
  const user = await requireRecordSigningAccess(kind, id);
  // Same lifecycle gate as start — never re-dispatch signing on a record that's
  // been trashed, superseded or already signed.
  const active = await checkRecordActive(kind, id);
  if (active.error) return { ok: false, error: active.error };
  const state = await activeRecordRequest({
    quoteId: kind === "quote" ? id : null,
    jobCardId: kind === "jobcard" ? id : null,
  });
  // A closed request (completed / declined / voided / expired / rejected) must
  // not be resent — resending would resurrect it (force it back to "sent" and
  // re-notify a declined recipient).
  if (!state || isRequestClosed(state.status)) {
    return { ok: false, error: "No active request to resend." };
  }
  // A resend deliberately re-notifies already-"sent" recipients — pass reminder so
  // notifyRecipient's at-most-once first-send claim doesn't skip them.
  const { notified } = await dispatchRequest(state.requestId, { reminder: true });
  await logAudit({
    action: "signing.remind",
    summary: `Resent “${state.title}” for signing`,
    entityType: "SignatureRequest",
    entityId: state.requestId,
    user,
  });
  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: state.requestId, notified };
}

export async function voidRecordSigning(
  kind: Kind,
  id: string,
): Promise<Result> {
  const user = await requireRecordSigningAccess(kind, id);
  const state = await activeRecordRequest({
    quoteId: kind === "quote" ? id : null,
    jobCardId: kind === "jobcard" ? id : null,
  });
  if (!state) return { ok: false, error: "No active request." };
  // Universal lock order — SOURCE record first, THEN the request (matching
  // completion / deletion / start) so void can't deadlock against a concurrent
  // completion. Conditional void so it can't overwrite a request a concurrent
  // signer just completed / declined (or another void); the quote drop-to-draft
  // rides in the same transaction.
  const voided = await basePrisma.$transaction(async (tx) => {
    if (kind === "quote") await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${id} FOR UPDATE`;
    else await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${id} FOR UPDATE`;
    const result = await tx.signatureRequest.updateMany({
      where: { id: state.requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
      data: { status: "voided" },
    });
    if (result.count === 0) return 0;
    if (kind === "quote") {
      await tx.quote.updateMany({ where: { id, status: "sent", signedAt: null }, data: { status: "draft" } });
    }
    return result.count;
  });
  if (voided === 0) {
    return { ok: false, error: "This request can no longer be voided." };
  }
  await logSignEvent(state.requestId, {
    type: "voided",
    actor: `Denago: ${user.name}`,
    metadata: { via: "record" },
  });
  await logAudit({
    action: "signing.void",
    summary: `Voided signing for “${state.title}”`,
    entityType: "SignatureRequest",
    entityId: state.requestId,
    user,
  });
  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: state.requestId };
}
