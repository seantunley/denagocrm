"use server";

import { revalidatePath } from "next/cache";
import { prisma, basePrisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import {
  requireQuoteAccess,
  requireJobCardAccess,
  canAccessQuote,
  canAccessJobCard,
  hasPermission,
  type PermissionUser,
} from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { saveFile, deleteFile } from "@/lib/storage";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "@/lib/signing/status";
import { quoteExpired } from "@/lib/quoteExpiry";
import { defaultBuilderTemplateId } from "@/lib/docbuilder/store";
import { resolveEnvelope } from "@/lib/signing/autoEnvelope";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { createSignatureRequestFromDoc, type SigningIdentityMode } from "@/lib/signing/service";
import { usableCapability } from "@/lib/signing/tokenVault";
import { signUrl } from "@/lib/signing/dispatch";
import { dispatchRequest, notifyRecipient } from "@/lib/signing/dispatch";
import { logSignEvent } from "@/lib/signing/events";
import { activeRecordRequest, isLockedForSigning, type QuoteSigningView } from "@/lib/signing/record";
import { advanceWorkflow, repairWorkflow, pendingApprovalNode } from "@/lib/signflow/runtime";
import { countersignWithSavedSignature } from "@/lib/signing/countersign";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import type { StampField } from "@/lib/doceditor/serialize";

type Kind = "quote" | "jobcard";
type Result = {
  ok: boolean;
  requestId?: string;
  error?: string;
  notified?: number;
  // Targets left "pending" with no usable contact channel (distinct from a
  // provider send that was attempted and failed) — lets the UI tell "add a
  // contact" apart from "delivery failed, retry".
  unreachable?: number;
  signFirstUrl?: string;
  modal?: boolean;
  /** Denago's countersignature is on the envelope; show it before it goes out. */
  preview?: boolean;
  /** The signer has no stored signature yet — capture one, then retry. */
  needsSignature?: boolean;
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
 * The signing state for one quote, for a surface that cannot read it
 * server-side — the quote editor dialog, which embeds the same signature card
 * the record page renders.
 *
 * Returns null rather than redirecting: this is a read for a panel, and a
 * caller who may not act on signing should simply not see the panel. Read
 * access is gated on the SAME permission as starting a request, because the
 * payload carries each recipient's secure signing link — a token that lets its
 * holder sign. requireQuoteAccess() is deliberately not used here; it calls
 * redirect(), which would throw NEXT_REDIRECT out of a data fetch.
 */
export async function quoteSigningView(id: string): Promise<QuoteSigningView | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  if (!(await hasPermission(user, "quotes.change_status"))) return null;
  if (!(await canAccessQuote(user, id))) return null;

  const quote = await prisma.quote.findUnique({
    where: { id },
    select: {
      status: true,
      deletedAt: true,
      supersededAt: true,
      signToken: true,
      signedAt: true,
      signedByName: true,
      signedPdfHash: true,
      dealerSignedAt: true,
      dealerSignedByName: true,
    },
  });
  // A superseded version is not signable and the record page hides the card for
  // it — findUnique is not soft-delete filtered, hence the explicit check.
  if (!quote || quote.deletedAt || quote.supersededAt) return null;

  const [state, workflows] = await Promise.all([
    activeRecordRequest({ quoteId: id }),
    prisma.signWorkflow.findMany({
      where: { isArchived: false },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  return {
    status: quote.status,
    // Both lock paths: a hub request in flight, and the historic signToken link.
    locked: isLockedForSigning(state) || (Boolean(quote.signToken) && !quote.signedAt),
    signedAt: quote.signedAt,
    signedByName: quote.signedByName,
    signedPdfHash: quote.signedPdfHash,
    dealerSignedAt: quote.dealerSignedAt,
    dealerSignedByName: quote.dealerSignedByName,
    hasSavedSignature: Boolean(user.drawnSignatureRef),
    workflows,
    state,
  };
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
  /**
   * Ask the signer to prove who they are with a one-time code, or accept
   * possession of the link as proof.
   *
   * Chosen per document, at the moment it is prepared. It is a real judgement:
   * a contract is worth the extra step, a delivery note is not, and forcing it
   * on everything is how a step-up becomes something people route around. The
   * server re-derives what is actually possible from the recipient's own
   * contact details, so asking for SMS on a signer with no number on file
   * degrades to "we cannot verify you" rather than a code sent nowhere.
   */
  // NO DEFAULT. Defaulting to "link" here made every caller an explicit choice
  // and silently disabled the workspace policy — the service treats an explicit
  // mode as outranking it, correctly, so the default has to be absence.
  identityMode?: SigningIdentityMode,
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
    // Heal the graph but do not notify: this is the START path, and the caller
    // is about to be shown the document to review before it goes anywhere.
    await repairWorkflow(existing.requestId, { notify: false });
    return { ok: true, requestId: existing.requestId, preview: true };
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
        identityMode,
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
    await repairWorkflow(outcome.requestId, { notify: false });
    return { ok: true, requestId: outcome.requestId, preview: true };
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

  // The workflow/cosign/signers branches below never call dispatchRequest (they
  // hand off to an IN-PERSON/modal or a workflow-driven flow instead) — nothing
  // is emailed/messaged, so they log "Started ... for signing", not "Sent".
  // Only the final fallback actually attempts email/WhatsApp delivery; it logs
  // "Sent" and gates that on notified > 0, so a send that reached nobody is
  // never recorded as sent.
  const logStartAudit = (verb: "Sent" | "Started") =>
    logAudit({
      action: "signing.send",
      summary: `${verb} “${envelope.title}” (${envelope.refLabel}) for signing`,
      contactId: envelope.contactId,
      leadId: sendLeadId,
      entityType: "SignatureRequest",
      entityId: requestId,
      user,
    });
  revalidatePath(recordPath(kind, id));

  if (isWorkflow && envelope.frozen) {
    await logStartAudit("Started");
    // The graph + recipient node IDs were committed in the creation transaction;
    // advance the first node now. advanceWorkflow is idempotent, and a retry that
    // reuses an un-advanced request repairs it the same way (repairWorkflow).
    //
    // notify: false — advancing used to email the first signer on the spot, so a
    // workflow whose first node is the customer reached them before anyone had
    // looked at the document. The graph moves; the sending is the send button's.
    await advanceWorkflow(requestId, { notify: false });
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
      // Same treatment as the built-in cosign: show the document, act on it
      // there. advanceWorkflow above already decided who is up; the preview
      // resolves whether that is the caller (countersign) or someone else (send).
      if (recipient) return { ok: true, requestId, preview: true };
    }
    return {
      ok: true,
      requestId: requestId,
      signFirstUrl: `/signatures/${requestId}`,
    };
  }

  if (envelope.signers) {
    await logStartAudit("Started");
    return {
      ok: true,
      requestId: requestId,
      signFirstUrl: `/signatures/${requestId}`,
    };
  }

  if (envelope.cosign) {
    await logStartAudit("Started");
    // Denago signs first, but not by being handed the customer's signing
    // surface a second time. The envelope is left un-dispatched; countersigning
    // and sending are two deliberate steps now.
    return { ok: true, requestId, preview: true };
  }

  const { notified, unreachable } = await dispatchRequest(requestId);
  if (notified > 0) await logStartAudit("Sent");
  return { ok: true, requestId: requestId, notified, unreachable };
}

/**
 * The next recipient who may act, in signing order. Viewers never sign, and a
 * sequential envelope only ever has one live signer — so this is the single
 * "who is up" answer both the countersign and the send button key off.
 */
async function nextSigner(requestId: string) {
  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    select: { workflowGraphJson: true, currentNodeId: true },
  });
  // A workflow envelope has a live node, and recipient ORDER is not it: a graph
  // with branches pre-creates a recipient for every path, so the lowest unsigned
  // order can easily be someone on a branch the condition did not take. Ask the
  // interpreter which node it is actually sitting on.
  if (request?.workflowGraphJson) {
    if (!request.currentNodeId) return null; // not advanced yet — nobody is up
    return prisma.signatureRecipient.findFirst({
      where: {
        requestId,
        nodeId: request.currentNodeId,
        role: { not: "viewer" },
        status: { notIn: ["signed", "declined"] },
      },
    });
  }
  return prisma.signatureRecipient.findFirst({
    where: { requestId, role: { not: "viewer" }, status: { notIn: ["signed", "declined"] } },
    orderBy: { order: "asc" },
  });
}

const sameParty = (a: string | null, b: string | null) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * Notify ONE named recipient and settle the request's send state around it.
 *
 * dispatchRequest() chooses its own targets from recipient order. For a plain
 * sequential envelope that is the same recipient; for a branched workflow it is
 * not, because a graph pre-creates a recipient per path and the lowest unsigned
 * order can sit on a branch the condition never took. The caller has already
 * resolved who is live, so send to exactly them.
 */
async function sendToRecipient(
  requestId: string,
  recipientId: string,
): Promise<{ notified: number; unreachable: number }> {
  const before = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    select: { sentAt: true },
  });
  const outcome = await notifyRecipient(recipientId);
  const notified = outcome.delivered ? 1 : 0;
  const unreachable = outcome.reachable ? 0 : 1;
  if (notified > 0) {
    // Same bookkeeping dispatchRequest does on a first successful send, and
    // conditional for the same reason: a void/decline can land during the
    // provider call, and an unconditional update would resurrect it. sentAt is
    // preserved once set — it is when the document FIRST went out, not when the
    // latest signer in the chain was reached.
    await prisma.signatureRequest.updateMany({
      where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
      data: { status: "sent", sentAt: before?.sentAt ?? new Date() },
    });
  }
  return { notified, unreachable };
}

/**
 * Denago countersigns the open envelope with the signer's stored signature.
 *
 * One click, no second signing surface. The customer is NOT notified here —
 * sendRecordSigning does that, after the countersigned document has been seen.
 */
export async function countersignRecord(kind: Kind, id: string): Promise<Result> {
  const user = await requireRecordSigningAccess(kind, id);
  const active = await checkRecordActive(kind, id);
  if (active.error) return { ok: false, error: active.error };

  const state = await activeRecordRequest({
    quoteId: kind === "quote" ? id : null,
    jobCardId: kind === "jobcard" ? id : null,
  });
  if (!state || isRequestClosed(state.status)) return { ok: false, error: "No open document to countersign." };

  const recipient = await nextSigner(state.requestId);
  if (!recipient) return { ok: false, error: "Everyone has already signed." };
  // Never sign in someone else's name. The built-in cosign envelope puts the
  // sender first (makeCosignable uses their own name and email); a workflow can
  // put a different staff member or the customer there, and that is theirs.
  if (!sameParty(recipient.email, user.email)) {
    return { ok: false, error: `${recipient.name} signs next — this is not yours to sign.` };
  }

  const me = await prisma.user.findUnique({
    where: { id: user.id },
    select: { drawnSignatureRef: true },
  });
  if (!me?.drawnSignatureRef) return { ok: false, needsSignature: true, error: "Add your signature first." };

  const signed = await countersignWithSavedSignature({
    requestId: state.requestId,
    recipientId: recipient.id,
    signatureRef: me.drawnSignatureRef,
    signedName: user.name,
  });
  if (!signed.ok) return { ok: false, error: signed.error };

  // A workflow envelope must move to its next node now, or nextSigner() would
  // keep pointing at the node just signed and the send button would refuse.
  // Still without notifying — the send is the send.
  const request = await prisma.signatureRequest.findUnique({
    where: { id: state.requestId },
    select: { workflowGraphJson: true },
  });
  if (request?.workflowGraphJson) await advanceWorkflow(state.requestId, { notify: false });

  await logAudit({
    action: "signing.countersigned",
    summary: `Countersigned “${state.title}” for Denago`,
    entityType: "SignatureRequest",
    entityId: state.requestId,
    user,
  });
  revalidatePath(recordPath(kind, id));
  return { ok: true, requestId: state.requestId, preview: true };
}

export type SignedDocView = {
  requestId: string;
  title: string;
  sheets: { width: number; height: number; margin: number; css: string; pages: string[] };
  stamps: StampField[];
  /** Who may act next, and whether that is the caller. */
  next: { id: string; name: string; email: string | null; isMe: boolean } | null;
  /**
   * The graph is parked on an internal approval gate. It has no recipient, so
   * `next` is null for it — without this the card would call that "fully signed"
   * and show no button at all, stranding the request.
   */
  approval: { label: string; raised: boolean } | null;
  /** The request has already gone out — the send button becomes a resend. */
  sent: boolean;
  hasSavedSignature: boolean;
};

/**
 * The document as it stands right now, rendered for on-screen review with every
 * signature already on it. Read-only and self-contained: no iframe, so it
 * cannot drag the app's own navigation chrome in behind it.
 */
export async function signedRecordDoc(kind: Kind, id: string): Promise<SignedDocView | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  // BOTH gates, for BOTH kinds. A module permission says you may work with job
  // cards; it does not say WHICH. This payload is the rendered document plus
  // every signature stamped on it, so a record-scoped user asking by id must be
  // refused the ones outside their scope — exactly as startRecordSigning's
  // requireJobCardAccess does on the write side.
  const permission = kind === "quote" ? "quotes.change_status" : "jobcards.manage";
  if (!(await hasPermission(user, permission))) return null;
  const allowed = kind === "quote" ? await canAccessQuote(user, id) : await canAccessJobCard(user, id);
  if (!allowed) return null;

  const state = await activeRecordRequest({
    quoteId: kind === "quote" ? id : null,
    jobCardId: kind === "jobcard" ? id : null,
  });
  if (!state) return null;
  const req = await prisma.signatureRequest.findUnique({ where: { id: state.requestId } });
  if (!req || req.deletedAt) return null;

  const [sheets, stamps, recipient, approval] = await Promise.all([
    renderRequestSigningSheets(req),
    // No exclusion — this view is nobody's turn to fill anything in, so every
    // completed field is shown as it will print.
    signedFieldStamps(req.id, ""),
    nextSigner(req.id),
    pendingApprovalNode(req.id),
  ]);

  return {
    requestId: req.id,
    title: req.title,
    sheets,
    stamps,
    next: recipient
      ? { id: recipient.id, name: recipient.name, email: recipient.email, isMe: sameParty(recipient.email, user.email) }
      : null,
    approval: approval ? { label: approval.label, raised: approval.raised } : null,
    sent: Boolean(req.sentAt),
    hasSavedSignature: Boolean(user.drawnSignatureRef),
  };
}

/** Send the countersigned document to whoever is up next. */
export async function sendRecordSigning(kind: Kind, id: string): Promise<Result> {
  const user = await requireRecordSigningAccess(kind, id);
  const active = await checkRecordActive(kind, id);
  if (active.error) return { ok: false, error: active.error };

  const state = await activeRecordRequest({
    quoteId: kind === "quote" ? id : null,
    jobCardId: kind === "jobcard" ? id : null,
  });
  if (!state || isRequestClosed(state.status)) return { ok: false, error: "No open document to send." };

  const recipient = await nextSigner(state.requestId);
  if (!recipient) {
    // An internal approval gate has no recipient row, so nextSigner() reports
    // nobody — but the workflow is very much waiting on someone. materialise()
    // now honours notify:false for approvals (it used to email the approver
    // straight off the countersign, before anyone had seen the document), so
    // raising the gate is the SEND's job, exactly as it is for a signer.
    // advanceWorkflow re-enters materialise with notify, whose createMany +
    // skipDuplicates makes the approver's email at-most-once however many times
    // this button is pressed.
    const gate = await pendingApprovalNode(state.requestId);
    if (!gate) return { ok: false, error: "Everyone has already signed." };
    if (gate.raised) {
      return { ok: false, error: `Waiting on “${gate.label}” — the approver has already been asked.` };
    }
    await advanceWorkflow(state.requestId);
    await logAudit({
      action: "signing.send",
      summary: `Sent “${state.title}” for approval (${gate.label})`,
      entityType: "SignatureRequest",
      entityId: state.requestId,
      user,
    });
    revalidatePath(recordPath(kind, id));
    return { ok: true, requestId: state.requestId };
  }
  if (sameParty(recipient.email, user.email)) {
    return { ok: false, error: "Countersign it first — you are next in the signing order." };
  }

  // Send to whoever is ACTUALLY up. dispatchRequest picks its targets by order,
  // which is right for a plain sequential envelope and wrong for a branched
  // workflow — there it would mail a recipient on a path the graph never took.
  const { notified, unreachable } = await sendToRecipient(state.requestId, recipient.id);
  if (notified > 0) {
    await logAudit({
      action: "signing.send",
      summary: `Sent “${state.title}” to ${recipient.name} for signing`,
      entityType: "SignatureRequest",
      entityId: state.requestId,
      user,
    });
  }
  revalidatePath(recordPath(kind, id));
  if (notified === 0) {
    return {
      ok: false,
      requestId: state.requestId,
      notified,
      unreachable,
      error: unreachable > 0
        ? `${recipient.name} has no email or phone on file — add one, then send.`
        : "The document could not be delivered — please try again.",
    };
  }
  return { ok: true, requestId: state.requestId, notified, unreachable };
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
  //
  // WHICH recipients, though. dispatchRequest picks its targets by recipient
  // ORDER, and a branched workflow pre-creates a recipient for EVERY path — so
  // the lowest unsigned order is routinely someone on a branch the condition
  // never took. Resending then nudged a party who is not up (and never will be)
  // with a live signing link, while the person actually holding up the deal
  // heard nothing. sendRecordSigning was fixed to send to nextSigner(); the
  // resend behind the very same document has to reach the very same person.
  // Order-based dispatch is kept for a plain sequential/parallel envelope, where
  // it is correct and also resends to ALL live signers in the parallel case.
  const workflow = await prisma.signatureRequest.findUnique({
    where: { id: state.requestId },
    select: { workflowGraphJson: true },
  });
  let notified: number;
  let unreachable: number;
  if (workflow?.workflowGraphJson) {
    const recipient = await nextSigner(state.requestId);
    if (!recipient) return { ok: false, error: "No active request to resend." };
    const outcome = await notifyRecipient(recipient.id, { reminder: true });
    notified = outcome.delivered ? 1 : 0;
    unreachable = outcome.reachable ? 0 : 1;
  } else {
    ({ notified, unreachable } = await dispatchRequest(state.requestId, { reminder: true }));
  }
  revalidatePath(recordPath(kind, id));
  // Truthful reporting: only log a resend once a provider actually accepted at
  // least one message — a request whose recipients were all unreachable or
  // whose sends all failed must not write a "Resent" audit entry.
  if (notified > 0) {
    await logAudit({
      action: "signing.remind",
      summary: `Resent “${state.title}” for signing`,
      entityType: "SignatureRequest",
      entityId: state.requestId,
      user,
    });
    return { ok: true, requestId: state.requestId, notified, unreachable };
  }
  // Nothing delivered — a resend the user explicitly asked for that reached
  // nobody is a failure, not a silent success: surface it so they can fix the
  // contact details or channel and try again.
  return {
    ok: false,
    requestId: state.requestId,
    notified,
    unreachable,
    error: unreachable > 0
      ? "No recipient has a usable contact channel — add an email or phone, then resend."
      : "The reminder could not be delivered — please try again.",
  };
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


/**
 * The shareable signing URL for one recipient, produced on demand.
 *
 * The card used to render `recipient.token` straight into a URL. That value is
 * now the stored DIGEST, and the public route hashes what arrives before it
 * queries — so the copied link resolved to hash(hash(raw)) and matched nothing.
 * Email links worked; anything copied from the CRM was dead, which is worse than
 * an obvious failure because it looks fine until a customer says otherwise.
 *
 * The raw capability exists only in ciphertext, so producing a link is a
 * privileged server operation rather than something the page can assemble: it
 * re-checks access, then reveals or atomically rotates. Rotation invalidates a
 * previously emailed link, which is the honest trade — the alternative is
 * handing someone a URL that cannot work.
 */
export async function recordSigningLink(
  kind: Kind,
  id: string,
  recipientId: string,
): Promise<{ url: string } | { error: string }> {
  await requireRecordSigningAccess(kind, id);
  const quoteId = kind === "quote" ? id : null;
  const jobCardId = kind === "jobcard" ? id : null;

  const request = await activeRecordRequest({ quoteId, jobCardId });
  if (!request) return { error: "There is no open signing request for this record." };

  const recipient = await prisma.signatureRecipient.findFirst({
    // Scoped through the request, so a recipient id from another record cannot
    // be used to mint a link here.
    where: { id: recipientId, requestId: request.requestId },
    select: { id: true, token: true, tokenCiphertext: true, tokenRevokedAt: true },
  });
  if (!recipient || recipient.tokenRevokedAt) return { error: "That signing link is no longer active." };

  const raw = await usableCapability(
    "signatureRecipient", recipient.id, recipient.tokenCiphertext, recipient.token,
  );
  if (!raw) return { error: "Could not prepare a signing link. Try sending the document again." };
  return { url: signUrl(raw) };
}
