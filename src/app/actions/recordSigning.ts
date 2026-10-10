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
import { quoteLinkExpiry } from "@/lib/signing/expiry";
import { voidOpenRequest } from "@/lib/signing/void";
import { nextSigner } from "@/lib/signing/nextSigner";
import { getRegionalSettings } from "@/lib/settings";
import { defaultBuilderTemplateId } from "@/lib/docbuilder/store";
import { publishedBuilderTemplateFor } from "@/lib/docbuilder/published";
import { resolveEnvelope } from "@/lib/signing/autoEnvelope";
import { renderEnvelopePdf } from "@/lib/signing/render";
import { createSignatureRequestFromDoc, type SigningIdentityMode } from "@/lib/signing/service";
import { usableCapability } from "@/lib/signing/tokenVault";
import { signUrl } from "@/lib/signing/dispatch";
import { dispatchRequest, notifyRecipient, sendToRecipient } from "@/lib/signing/dispatch";
import { logSignEvent, staffActor } from "@/lib/signing/events";
import { activeRecordRequest, isLockedForSigning, type QuoteSigningView } from "@/lib/signing/record";
import { advanceWorkflow, repairWorkflow, pendingApprovalNode } from "@/lib/signflow/runtime";
import { countersignWithSavedSignature } from "@/lib/signing/countersign";
import { renderRequestSigningSheets, signedFieldStamps } from "@/lib/signing/render";
import type { StampField } from "@/lib/doceditor/serialize";
import { withActingStaffScope } from "@/lib/actingScope";

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
  return withActingStaffScope(async () => {
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
  });
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
    // A cancel that lands after this check still bumps updatedAt, so the locked
    // version check in startRecordSigning refuses it as stale.
    if (quote.status === "cancelled") {
      return { error: "This quote was cancelled — duplicate it to send a new one.", leadId: null, version: null };
    }
    if (quoteExpired(quote.validUntil, (await getRegionalSettings()).timeZone)) {
      return { error: "This quote has expired — issue an updated quote first.", leadId: null, version: null };
    }
    return { error: null, leadId: quote.leadId, version: quote.updatedAt.getTime() };
  }
  const jobCard = await prisma.jobCard.findUnique({ where: { id } });
  if (!jobCard || jobCard.deletedAt) return { error: "Job card not found.", leadId: null, version: null };
  if (jobCard.signedAt) return { error: "This job card has already been signed.", leadId: null, version: null };
  return { error: null, leadId: null, version: jobCard.updatedAt.getTime() };
}

/**
 * Is this uploaded file referenced by anything durable?
 *
 * Checks BOTH references the preparation transaction files — the request's
 * unsignedPdfRef and the Document row's storedName — unfiltered, so a
 * soft-deleted request still counts as a reference. Returns false (retain) on
 * any error or unexpected answer.
 */
async function unsignedPdfIsSafeToDelete(storedName: string): Promise<boolean> {
  try {
    const [request, document] = await Promise.all([
      basePrisma.signatureRequest.findFirst({ where: { unsignedPdfRef: storedName }, select: { id: true } }),
      basePrisma.document.findFirst({ where: { storedName }, select: { id: true } }),
    ]);
    return request === null && document === null;
  } catch {
    // The failure that lost the commit acknowledgement is usually the same one
    // that breaks this probe. Uncertainty retains.
    return false;
  }
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
  return withActingStaffScope(async () => {
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

    // Quote signing uses the editable builder template. A job card uses its builder
    // layout only once that layout is PUBLISHED (the same switch as its print page);
    // until then null keeps resolveEnvelope on its synthesised standard layout.
    const templateId =
      kind === "quote"
        ? await defaultBuilderTemplateId("quote")
        : (await publishedBuilderTemplateFor("jobcard"))?.id ?? null;
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
    // The envelope is rendered FROM the source record, so the source record owns it —
    // and so will the Document row and the SignatureRequest created from it below.
    // Verbatim, NULL included: a quote written before stamping cannot confer an
    // owner, and substituting the signer's would put the contract in a workspace the
    // quote is not in.
    const sourceTenantId = quoteId
      ? (await prisma.quote.findUnique({ where: { id: quoteId }, select: { tenantId: true } }))?.tenantId ?? null
      : (await prisma.jobCard.findUnique({ where: { id: jobCardId! }, select: { tenantId: true } }))?.tenantId ?? null;
    const storedName = await saveFile(
      pdf,
      `${envelope.title}.pdf`,
      "application/pdf",
      sourceTenantId,
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
    // Resolved before the lock: expiry is judged on the workspace calendar.
    const { timeZone } = await getRegionalSettings();
    const isWorkflow = Boolean(envelope.frozen && envelope.signers);
    let committedRequestId: string | null = null;
    let outcome:
      | { kind: "stale" }
      | { kind: "reused"; requestId: string }
      | { kind: "created"; requestId: string } = { kind: "stale" };
    try {
      outcome = await basePrisma.$transaction(async (tx) => {
        // The link stops working when the quote does. Read under the same lock
        // that proves this is the version being sent. A job card has no validity
        // date, so its link has no expiry.
        let linkExpiresAt: Date | null = null;
        if (quoteId) {
          await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${quoteId} FOR UPDATE`;
          const q = await tx.quote.findUnique({
            where: { id: quoteId },
            select: { deletedAt: true, signedAt: true, supersededAt: true, validUntil: true, updatedAt: true },
          });
          if (!q || q.deletedAt || q.signedAt || q.supersededAt || quoteExpired(q.validUntil, timeZone) || q.updatedAt.getTime() !== sourceVersion) {
            return { kind: "stale" as const };
          }
          linkExpiresAt = quoteLinkExpiry(q.validUntil, timeZone);
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
            // What the comment on sourceTenantId above already promised — "and so
            // will the Document row" — but never actually did.
            tenantId: sourceTenantId,
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
          expiresAt: linkExpiresAt,
          // The customer's details as the quote or job card holds them — for a
          // quote made straight from a lead there is no contact to read them from.
          customer: { email: envelope.customerEmail, phone: envelope.customerPhone },
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
      // ASK THE DATABASE, never infer from the thrown error.
      //
      // This used to delete the blob whenever the transaction promise did not
      // resolve — reasoning that a rejection meant nothing committed. That is the
      // exact mistake behind the Q-1010 signed-PDF loss: a thrown COMMIT
      // acknowledgement is not proof of rollback. If PostgreSQL committed and only
      // the acknowledgement was lost, the Document row and the SignatureRequest
      // both name this file, and deleting it destroys the document underneath
      // records that say it exists.
      //
      // So the blob is removed only when a positive read proves NOTHING durable
      // references it. Any uncertainty — an error, an unexpected shape, a broken
      // connection (usually the same one that lost the acknowledgement) — retains
      // the file. A stranded blob costs storage; a deleted one loses the contract.
      if (!committedRequestId && (await unsignedPdfIsSafeToDelete(storedName))) {
        await deleteFile(storedName).catch(() => {});
      }
    }
    if (outcome.kind === "stale") {
      return { ok: false, error: "This record changed while the signing document was being prepared — please try again." };
    }
    if (outcome.kind === "reused") {
      await repairWorkflow(outcome.requestId, { notify: false });
      return { ok: true, requestId: outcome.requestId, preview: true };
    }
    const requestId: string = outcome.requestId;

    // No branch below emails or messages anyone — they hand off to a review, an
    // in-person or a workflow-driven flow — so they log "Started", never "Sent".
    const logStartAudit = (verb: "Started") =>
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

    // STARTING NEVER SENDS. Whether or not the layout has a Denago block to
    // countersign, the envelope is left un-dispatched and shown for review; only
    // an explicit Send (sendRecordSigning) reaches the customer.
    //
    // This used to fall through to dispatchRequest() whenever the layout had no
    // Denago party — a quote template with only a customer signature block. The
    // "✍ Countersign & review" click then mailed the customer on the spot, with
    // no review at all: on 2026-09-30 it sent Q-1022 to its customer from an
    // editor the owner believed was showing a different quote.
    await logStartAudit("Started");
    return { ok: true, requestId, preview: true };
  });
}

const sameParty = (a: string | null, b: string | null) =>
  Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * A send reaches a customer, so it must be the document the sender actually
 * looked at. The card passes the request id it rendered; if the record's live
 * request is a different one — a stale tab, a request discarded and restarted
 * elsewhere, a card left over from another quote — refuse rather than mail
 * something nobody reviewed.
 */
const notTheReviewedDocument = (liveRequestId: string, reviewedRequestId: string) =>
  liveRequestId !== reviewedRequestId;
const STALE_REVIEW = "This document changed since you opened it — close it and review it again before sending.";

/**
 * Denago countersigns the open envelope with the signer's stored signature.
 *
 * One click, no second signing surface. The customer is NOT notified here —
 * sendRecordSigning does that, after the countersigned document has been seen.
 */
export async function countersignRecord(kind: Kind, id: string): Promise<Result> {
  return withActingStaffScope(async () => {
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
      summary: `Countersigned “${state.title}”`,
      entityType: "SignatureRequest",
      entityId: state.requestId,
      user,
    });
    revalidatePath(recordPath(kind, id));
    return { ok: true, requestId: state.requestId, preview: true };
  });
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
  return withActingStaffScope(async () => {
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
  });
}

/** Send the countersigned document to whoever is up next. */
export async function sendRecordSigning(
  kind: Kind,
  id: string,
  /** The request whose document the sender is looking at — see notTheReviewedDocument. */
  reviewedRequestId: string,
): Promise<Result> {
  return withActingStaffScope(async () => {
    const user = await requireRecordSigningAccess(kind, id);
    const active = await checkRecordActive(kind, id);
    if (active.error) return { ok: false, error: active.error };

    const state = await activeRecordRequest({
      quoteId: kind === "quote" ? id : null,
      jobCardId: kind === "jobcard" ? id : null,
    });
    if (!state || isRequestClosed(state.status)) return { ok: false, error: "No open document to send." };
    if (notTheReviewedDocument(state.requestId, reviewedRequestId)) return { ok: false, error: STALE_REVIEW };

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
  });
}

export async function resendRecordSigning(
  kind: Kind,
  id: string,
  /** The request the resend button belongs to — see notTheReviewedDocument. */
  reviewedRequestId: string,
): Promise<Result> {
  return withActingStaffScope(async () => {
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
    if (notTheReviewedDocument(state.requestId, reviewedRequestId)) return { ok: false, error: STALE_REVIEW };
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
  });
}

export async function voidRecordSigning(
  kind: Kind,
  id: string,
): Promise<Result> {
  return withActingStaffScope(async () => {
    const user = await requireRecordSigningAccess(kind, id);
    const state = await activeRecordRequest({
      quoteId: kind === "quote" ? id : null,
      jobCardId: kind === "jobcard" ? id : null,
    });
    if (!state) return { ok: false, error: "No active request." };
    // The one void (lib/signing/void.ts): source record locked first, a
    // conditional void, and a sent quote back to draft in the same transaction —
    // shared with the Signatures page, whose own void used to leave the quote
    // saying "Sent".
    if (!(await voidOpenRequest(state.requestId))) {
      return { ok: false, error: "This request can no longer be voided." };
    }
    await logSignEvent(state.requestId, {
      type: "voided",
      actor: await staffActor(user.name),
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
  });
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
  return withActingStaffScope(async () => {
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
  });
}
