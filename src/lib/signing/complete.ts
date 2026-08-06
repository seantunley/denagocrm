import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml, type StampField } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import { sealPdf } from "@/lib/pdf/seal";
import { saveFile, readFile, deleteFile } from "@/lib/storage";
import { formatDateTime } from "@/lib/format";
import { logError } from "@/lib/errorLog";
import { resolveTenantActor } from "@/lib/tenantActor";
import { bindCtx, logoDataUri } from "./render";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";
import { requestTrustedTimestamp } from "./timestamp";
import { runPostCompletion } from "./postComplete";
import { signedPdfIsSafeToDelete } from "./blobReferences";
import {
  COMPLETED_EVENT,
  POST_COMPLETION_EVENT,
  deliverCompletionEmails,
} from "./completionFanout";
import { exactTenantWhere } from "./recoveryScope";

/** Internal sentinel: the completion claim was lost to a concurrent close. */
class CompletionLost extends Error {}
/** Internal sentinel: the source quote/job card couldn't be signed (ineligible). */
class SourceCompletionLost extends Error {}

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sigImg(ref: string | null): Promise<string | null> {
  if (!ref) return null;
  try { const buf = await readFile(ref); return `data:image/png;base64,${buf.toString("base64")}`; } catch { return null; }
}

type RecipientRow = {
  name: string; role: string; signedAt: Date | null; signerIp: string | null; img: string | null;
  /** How this signer was proved to be the intended recipient, if at all. */
  identityMethod: string | null; identityVerifiedAt: Date | null;
};

/**
 * What the certificate is allowed to claim about a signer's identity.
 *
 * Stated plainly and WITHOUT overclaiming, because this is the paragraph that
 * gets read in a dispute. "Link" is the honest description of possession-only
 * signing — it is not nothing, but it is not proof of who held the link, and
 * dressing it up as verification would be worse than saying so.
 */
function identityStatement(row: RecipientRow): string {
  if (row.identityMethod === "email_otp") {
    return `Identity verified by one-time code sent to the email address on file${
      row.identityVerifiedAt ? ` at ${formatDateTime(row.identityVerifiedAt)}` : ""}`;
  }
  if (row.identityMethod === "sms_otp") {
    return `Identity verified by one-time code sent to the mobile number on file${
      row.identityVerifiedAt ? ` at ${formatDateTime(row.identityVerifiedAt)}` : ""}`;
  }
  return "Opened using the unique signing link sent to this recipient (no additional identity check was required for this document)";
}

function certificateHtml(title: string, requestId: string, rows: RecipientRow[]): string {
  const signers = rows.map((r) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <div style="display:flex;justify-content:space-between"><strong>${esc(r.name)}</strong><span style="color:#64748b;font-size:9pt">${esc(r.role)}</span></div>
      ${r.img ? `<img src="${r.img}" style="height:56px;margin:8px 0"/>` : `<div style="color:#94a3b8;font-size:9pt;margin:8px 0">(accepted without drawn signature)</div>`}
      <div style="font-size:8.5pt;color:#64748b">Signed ${r.signedAt ? esc(formatDateTime(r.signedAt)) : "—"}${r.signerIp ? ` · IP ${esc(r.signerIp)}` : ""}</div>
      <div style="font-size:8.5pt;color:#64748b">${esc(identityStatement(r))}</div>
    </div>`).join("");
  return `<div style="page-break-before:always;padding-top:6px">
    <h1 style="font-size:18pt;color:#020617;margin:0 0 4px">Certificate of Completion</h1>
    <p style="color:#64748b;font-size:10pt;margin:0 0 12px">Audit record for “${esc(title)}” · ref ${esc(requestId)}</p>
    ${signers}
    <div style="margin-top:14px;background:#f8fafc;border-left:3px solid #ea580c;padding:12px;font-size:9pt;color:#334155">
      Signed electronically in terms of the Electronic Communications and Transactions Act 25 of 2002 (South Africa).
      This document carries a PKCS#7 digital seal; any change after sealing invalidates the signature and is detectable
      by any standard PDF reader.
      <br/><br/>The times recorded above are this system&rsquo;s own.
    </div>
  </div>`;
}

/** Text form of one shared-field response for the acknowledgements record. */
function describeResponseValue(kind: string, value: string): string {
  if (kind === "checkbox") return value === "true" ? "✓ checked" : "✗ unchecked";
  if (kind === "signature" || kind === "initials" || kind === "stamp") return "signed";
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

type AckField = {
  id: string;
  label: string;
  kind: string;
  page: number;
  responseByRecipient: Map<string, { value: string; filledAt: Date }>;
};
type AckSigner = { id: string; name: string };

/**
 * A "Shared field acknowledgements" page for the certificate. A shared field
 * (recipientId null) has one placed position, so the stamped document shows only
 * the first signer's value — every signer's own answer lives in
 * SignatureFieldResponse. Record all of them here so the sealed PDF's audit
 * pages, not just the live hub, carry the full acknowledgement trail.
 *
 * Every shared field is listed (not only ones with at least one response), and
 * every expected non-viewer signer is listed against it in signer order —
 * "Not answered" where a signer left it blank — so the sealed record can't
 * silently omit a field or a signer. Fields are identified by page + a stable
 * field-id fragment so two identically- or blank-labelled fields are never
 * ambiguous. Returns "" (no page) when the document has no shared fields at all.
 */
function acknowledgementsHtml(fields: AckField[], signers: AckSigner[]): string {
  if (fields.length === 0) return "";
  const blocks = fields.map((f) => {
    const items = signers.map((signer) => {
      const who = esc(signer.name);
      const response = f.responseByRecipient.get(signer.id);
      if (!response) {
        return `<li style="font-size:9pt;color:#94a3b8;margin:2px 0"><strong>${who}</strong> · Not answered</li>`;
      }
      const when = esc(formatDateTime(response.filledAt));
      return `<li style="font-size:9pt;color:#334155;margin:2px 0"><strong>${who}</strong> · ${esc(describeResponseValue(f.kind, response.value))} <span style="color:#94a3b8">· ${when}</span></li>`;
    }).join("");
    return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <div style="font-size:10pt;font-weight:600;color:#020617;margin-bottom:2px">${esc(f.label || f.kind)}</div>
      <div style="font-size:8pt;color:#94a3b8;margin-bottom:6px">Page ${f.page + 1} · field ${esc(f.id.slice(-8))}</div>
      <ul style="margin:0;padding-left:16px">${items}</ul>
    </div>`;
  }).join("");
  return `<div style="page-break-before:always;padding-top:6px">
    <h1 style="font-size:18pt;color:#020617;margin:0 0 4px">Shared field acknowledgements</h1>
    <p style="color:#64748b;font-size:10pt;margin:0 0 12px">Every expected signer’s response to a field any recipient could complete, in signer order. The document stamps the first response; all are recorded here.</p>
    ${blocks}
  </div>`;
}

/** Assemble the final signed PDF (document + certificate), seal it, file it, notify everyone. */
export async function completeSignatureRequest(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    include: { recipients: { orderBy: { order: "asc" } } },
  });
  // A request that is already closed (completed, voided or declined) must never
  // be completed. Voiding races with the final signer's transaction: the signer
  // commits the recipient + fields, then calls this outside that lock, so a void
  // can land in between. Reject here AND re-check with a conditional claim below.
  if (!req || isRequestClosed(req.status)) return;
  const doc = parseDocument(req.snapshotJson);
  if (!doc) return;

  // Resolve who owns the signed Document UP FRONT — before rendering or storing
  // anything. Document.uploadedById is a required FK, so with nobody to
  // attribute it to the sealed PDF ends up filed against no Document row: the
  // quote reads as signed and accepted while the contract itself appears on no
  // Documents tab and in no deliveries chip.
  //
  // No creator recorded → a member of THIS request's tenant, never the global
  // oldest user (resolveTenantActor).
  //
  // Resolving here, rather than just before the write, is deliberate. By the
  // time we reach the write the recipient's signature is already committed by
  // the caller and the sealed PDF is already in storage — so failing there
  // strands a request nothing can re-drive (every signer has signed, so
  // advanceAfterSignature is never called again and the signing endpoint just
  // answers "Already signed"), and leaks the stored blob past the cleanup
  // handler below. This costs one query and happens before any of that.
  const uploaderId = req.createdById || (await resolveTenantActor())?.id || null;
  if (!uploaderId) {
    // And we still COMPLETE. The customer has signed — a legal fact that must
    // not be undone by our own bookkeeping. The sealed PDF stays reachable on
    // the request (signedPdfRef); what's missing is the Documents-tab entry.
    // Server log, not logError: an operator-visible anomaly is not a reason to
    // push an alert to someone's phone.
    console.error(
      `[signing] request ${requestId}: no user to attribute the signed document to. ` +
        `Completing without a Document row — the sealed PDF is on the request (signedPdfRef) ` +
        `but will not appear on the Documents tab or the deliveries board until it is refiled.`,
    );
  }

  const ctx = await bindCtx(req.quoteId, req.jobCardId);

  const rows: RecipientRow[] = [];
  for (const r of req.recipients.filter((x) => x.status === "signed")) {
    rows.push({ name: r.signedName || r.name, role: r.role, signedAt: r.signedAt, signerIp: r.signerIp, img: await sigImg(r.signatureRef), identityMethod: r.identityMethod, identityVerifiedAt: r.identityVerifiedAt });
  }

  // Stamp each signed field into the document at the exact spot it was placed.
  const nameByRecipient = new Map(req.recipients.map((r) => [r.id, r.signedName || r.name]));
  const fieldRows = await prisma.signatureField.findMany({ where: { requestId, filledAt: { not: null } } });
  const stampedFields: StampField[] = [];
  for (const f of fieldRows) {
    const base = { page: f.page, x: f.x, y: f.y, width: f.width, height: f.height, kind: f.kind };
    if (f.kind === "signature" || f.kind === "initials" || f.kind === "stamp") {
      const img = await sigImg(f.value); // f.value is a stored file ref for image fields
      if (img) stampedFields.push({ ...base, image: img, label: f.recipientId ? nameByRecipient.get(f.recipientId) : "" });
    } else if (f.kind === "checkbox") {
      stampedFields.push({ ...base, text: f.value === "true" ? "✓" : "" });
    } else {
      stampedFields.push({ ...base, text: f.value ?? "" });
    }
  }

  // Shared fields (recipientId null) keep only the first value on SignatureField;
  // pull every recipient's own answer from SignatureFieldResponse so the sealed
  // PDF's audit pages carry the full acknowledgement trail, not just the stamp.
  // Every shared field is included here (not filtered to ones with a response)
  // and ordered deterministically by page/position/id — acknowledgementsHtml
  // fills in "Not answered" for any expected signer missing from a field's
  // response set.
  const sharedFields = await prisma.signatureField.findMany({
    where: { requestId, recipientId: null },
    include: { responses: true },
    orderBy: [{ page: "asc" }, { y: "asc" }, { x: "asc" }, { id: "asc" }],
  });
  const ackFields: AckField[] = sharedFields.map((f) => ({
    id: f.id,
    label: f.label,
    kind: f.kind,
    page: f.page,
    responseByRecipient: new Map(f.responses.map((r) => [r.recipientId, { value: r.value, filledAt: r.filledAt }])),
  }));
  // Every expected non-viewer signer, in signer order — not just those who
  // ended up signing, so a field they left blank still shows "Not answered"
  // against their name rather than disappearing.
  const expectedSigners: AckSigner[] = req.recipients
    .filter((r) => r.role !== "viewer")
    .map((r) => ({ id: r.id, name: r.signedName || r.name }));

  const html = renderDocumentHtml(doc, ctx, logoDataUri(), {
    hideOverlays: true,
    stampedFields,
    appendHtml: certificateHtml(req.title, req.id, rows) + acknowledgementsHtml(ackFields, expectedSigners),
  });
  let pdf = await htmlToPdf(html);
  pdf = await sealPdf(pdf, { reason: `Signed: ${req.title}`, name: "Denago Cape Town" });
  const hash = crypto.createHash("sha256").update(pdf).digest("hex");

  // Independent proof of WHEN, requested BEFORE the completion transaction so a
  // slow authority cannot hold a database transaction open — and awaited rather
  // than fired off, because a timestamp that arrives after the record is filed
  // attests to the wrong moment.
  //
  // Returns null on any problem, and that is the intended behaviour: the
  // authority is a third party we do not control, and losing a signed contract
  // to somebody else's outage would be far worse than filing one without an
  // external attestation. The certificate says which of the two happened.
  const stamp = await requestTrustedTimestamp(Buffer.from(hash, "hex"));
  const storedName = await saveFile(pdf, `${req.title} (signed).pdf`, "application/pdf");

  const firstSigner = req.recipients.find((r) => r.status === "signed" && r.role !== "viewer");
  const signerName = firstSigner?.signedName || firstSigner?.name || "Customer";

  // Create the signed Document, claim completion, AND sign the SOURCE record
  // (quote/job card) in ONE transaction. Previously the source was signed
  // afterwards in a best-effort, error-swallowing step, so a crash could leave
  // the request "completed" and the PDF distributed while the quote/job card
  // stayed unsigned — with no retry path (the closed request short-circuits).
  // Signing the source here (guarded live + unsigned + not-superseded) makes the
  // core state atomic; only external fan-out (automations, push) is best-effort.
  // A lost claim rolls the Document row back; the blob is kept only once claimed.
  let documentId: string | null = null;
  let sourceSigned = false;
  let wonLeadId: string | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      // Universal lock order — SOURCE record first, THEN the signature request —
      // matching quote/job-card deletion and signing start. Completion used to
      // touch the request before the source while deletion did the reverse, so a
      // final signature racing a delete could deadlock (each holding what the
      // other needed). Locking the source row up front makes the order consistent.
      if (req.quoteId) await tx.$executeRaw`SELECT id FROM "Quote" WHERE id = ${req.quoteId} FOR UPDATE`;
      else if (req.jobCardId) await tx.$executeRaw`SELECT id FROM "JobCard" WHERE id = ${req.jobCardId} FOR UPDATE`;
      // Always created when an uploader exists (the normal path, and what makes
      // the signed contract findable); null only in the logged anomaly above,
      // where completing still beats stranding a signature.
      const document = uploaderId
        ? await tx.document.create({
            data: {
              fileName: `${req.title} (signed).pdf`, storedName, mimeType: "application/pdf", sizeBytes: pdf.length,
              quoteId: req.quoteId, jobCardId: req.jobCardId, contactId: req.contactId, tag: "signed", uploadedById: uploaderId,
            },
          })
        : null;
      const claimed = await tx.signatureRequest.updateMany({
        where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
        data: {
          status: "completed", completedAt: new Date(), signedPdfRef: storedName,
          signedPdfHash: hash, signedDocId: document?.id ?? null,
          timestampToken: stamp?.tokenBase64 ?? null,
          timestampedAt: stamp?.genTime ?? null,
          timestampAuthority: stamp?.authority ?? null,
        },
      });
      if (claimed.count === 0) throw new CompletionLost();
      documentId = document?.id ?? null;

      if (req.quoteId) {
        const signedQuote = await tx.quote.updateMany({
          where: { id: req.quoteId, deletedAt: null, supersededAt: null, signedAt: null },
          data: { signedAt: new Date(), signedByName: signerName, status: "accepted", declinedAt: null, declineReason: null, signedPdfHash: hash },
        });
        if (signedQuote.count === 1) {
          sourceSigned = true;
          const q = await tx.quote.findUnique({ where: { id: req.quoteId }, select: { leadId: true } });
          if (q?.leadId) {
            // Win the lead in the SAME transaction, locked, so quote-accepted and
            // lead-won can't diverge under a concurrent decline/accept.
            await tx.$executeRaw`SELECT id FROM "Lead" WHERE id = ${q.leadId} FOR UPDATE`;
            const won = await tx.lead.updateMany({ where: { id: q.leadId, deletedAt: null, status: "open" }, data: { status: "won" } });
            if (won.count === 1) wonLeadId = q.leadId;
          }
        } else {
          // Didn't sign it. Completing anyway is only OK if the quote is ALREADY
          // signed (e.g. the legacy /sign path beat us); a deleted / superseded /
          // missing quote is ineligible, so roll the whole completion back rather
          // than complete + distribute a PDF for a quote that never got signed.
          const q = await tx.quote.findUnique({ where: { id: req.quoteId }, select: { signedAt: true, deletedAt: true, supersededAt: true } });
          if (!q || q.deletedAt || q.supersededAt || !q.signedAt) throw new SourceCompletionLost();
        }
      } else if (req.jobCardId) {
        const signedJc = await tx.jobCard.updateMany({
          where: { id: req.jobCardId, deletedAt: null, signedAt: null },
          // signedPdfHash is written here for the same reason the quote branch
          // writes it: it is the evidence that THIS request's transaction is the
          // one that signed the job card. Without it a recovery pass cannot tell
          // "we signed it" from "somebody else already had", and re-fires the
          // won-effects for a job that was already booked.
          data: { signedAt: new Date(), signedByName: signerName, signedPdfHash: hash },
        });
        if (signedJc.count === 1) {
          sourceSigned = true;
        } else {
          const jc = await tx.jobCard.findUnique({ where: { id: req.jobCardId }, select: { signedAt: true, deletedAt: true } });
          if (!jc || jc.deletedAt || !jc.signedAt) throw new SourceCompletionLost();
        }
      }
    });
  } catch (err) {
    // A thrown error is NOT proof the transaction rolled back. If the COMMIT
    // succeeded and only its acknowledgement was lost, Postgres has committed:
    // signedPdfRef and the new Document row both name this blob, and deleting it
    // destroys the signed artefact underneath a record that says it exists.
    //
    // That is what happened to Quote Q-1010 on 2026-08-04 — see
    // SIGNING-PDF-LOSS-INCIDENT.md. So ASK before deleting, and keep the file on
    // every ambiguous answer, including a failed check (usually the same broken
    // connection that lost the acknowledgement).
    //
    // Ask about EVERY durable reference, not just the request row. The
    // transaction files two — `SignatureRequest.signedPdfRef` and the `Document`
    // whose `storedName` is this blob — and asking only the first reopens the
    // hole by another door: the request is soft-deletable, so once it is trashed
    // a filtered lookup answers "no row", the check says "unreferenced", and the
    // blob is deleted out from under the Document the signed PDF is filed as.
    // signedPdfIsSafeToDelete does both, unfiltered and tenant-scoped.
    if (await signedPdfIsSafeToDelete(storedName, req.tenantId)) {
      await deleteFile(storedName).catch(() => {});
    }
    if (err instanceof CompletionLost || err instanceof SourceCompletionLost) return;
    throw err;
  }

  // The owning tenant, taken from the row rather than from ambient scope: the
  // db.ts guard rewrites nothing while enforcement is dormant, and these are
  // writes. Parent and children are created in one transaction, so the request's
  // own tenantId is exactly its recipients'.
  const tenantWhere = exactTenantWhere(req.tenantId);

  // External fan-out only (referral, automations, push, audit). The core source
  // state is already committed above; this never unwinds it — but it now REPORTS
  // what it swallowed, because the marker written at the end of this function is
  // the flag that stops the request ever being swept again.
  const post = await runPostCompletion({
    id: req.id,
    title: req.title,
    quoteId: req.quoteId,
    jobCardId: req.jobCardId,
    signedByName: signerName,
    signedPdfHash: hash,
    signedDocId: documentId,
    sourceSigned,
    wonLeadId,
  });
  // Its own marker, so a retry caused by one undeliverable address does not
  // re-fire the automations and write a second audit line.
  if (post.ok) {
    await logSignEvent(requestId, { type: POST_COMPLETION_EVENT, actor: "system" });
  }

  // Email the sealed PDF to every recipient with an address, recording each
  // delivery on the recipient. This loop used to be `await sendEmail(...)` with
  // the result discarded — and sendEmail NEVER THROWS, it returns { ok: false }
  // — so a fan-out that reached nobody looked exactly like one that reached
  // everybody, and the completion marker below was written over it.
  const delivery = await deliverCompletionEmails({
    title: req.title,
    pdf,
    recipients: req.recipients.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      completedEmailSentAt: r.completedEmailSentAt,
    })),
    tenantWhere,
  });

  // LAST, not first, and ONLY on success. This event used to be written
  // immediately after the transaction, which made it a record that the commit
  // happened — but nothing then recorded whether the work above actually ran,
  // and nothing could: advanceAfterSignature and completeSignatureRequest both
  // return early on a closed request, so a completion that committed and failed
  // to notify anyone was unreachable forever, and silent.
  //
  // Written here, its absence means exactly one thing — "committed, but the
  // fan-out did not finish" — which is what recoverStrandedCompletions() sweeps
  // for. Writing it anyway after a failed send would be strictly worse than the
  // original bug: it would mark the request handled and suppress the very
  // recovery that exists to rescue it. The completion TIME is unaffected:
  // `completedAt` on the row is set inside the transaction and remains the
  // authoritative timestamp.
  if (post.ok && delivery.ok) {
    await logSignEvent(requestId, { type: COMPLETED_EVENT, actor: "system", metadata: { hash } });
    return;
  }

  const failures = [...post.failures, ...delivery.failures];
  const message =
    `Signature request ${requestId} completed but its fan-out did not finish: ${failures.join("; ")}. ` +
    `Left unmarked so the stranded-completion sweep re-drives it.`;
  console.error(`[signing] ${message}`);
  await logError("signing-completion-fanout", new Error(message), `request ${requestId}`).catch(() => {});
}
