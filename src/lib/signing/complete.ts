import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml, type StampField } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import { sealPdf } from "@/lib/pdf/seal";
import { saveFile, readFile, deleteFile } from "@/lib/storage";
import { sendEmail } from "@/lib/email";
import { formatDateTime } from "@/lib/format";
import { resolveTenantActor } from "@/lib/tenantActor";
import { bindCtx, logoDataUri } from "./render";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";
import { runPostCompletion } from "./postComplete";

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

type RecipientRow = { name: string; role: string; signedAt: Date | null; signerIp: string | null; img: string | null };

function certificateHtml(title: string, requestId: string, rows: RecipientRow[]): string {
  const signers = rows.map((r) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <div style="display:flex;justify-content:space-between"><strong>${esc(r.name)}</strong><span style="color:#64748b;font-size:9pt">${esc(r.role)}</span></div>
      ${r.img ? `<img src="${r.img}" style="height:56px;margin:8px 0"/>` : `<div style="color:#94a3b8;font-size:9pt;margin:8px 0">(accepted without drawn signature)</div>`}
      <div style="font-size:8.5pt;color:#64748b">Signed ${r.signedAt ? esc(formatDateTime(r.signedAt)) : "—"}${r.signerIp ? ` · IP ${esc(r.signerIp)}` : ""}</div>
    </div>`).join("");
  return `<div style="page-break-before:always;padding-top:6px">
    <h1 style="font-size:18pt;color:#020617;margin:0 0 4px">Certificate of Completion</h1>
    <p style="color:#64748b;font-size:10pt;margin:0 0 12px">Audit record for “${esc(title)}” · ref ${esc(requestId)}</p>
    ${signers}
    <div style="margin-top:14px;background:#f8fafc;border-left:3px solid #ea580c;padding:12px;font-size:9pt;color:#334155">
      Signed electronically in terms of the Electronic Communications and Transactions Act 25 of 2002 (South Africa).
      This document carries a PKCS#7 digital seal; any change after sealing invalidates the signature and is detectable
      by any standard PDF reader.
    </div>
  </div>`;
}

/** Text form of one shared-field response for the acknowledgements record. */
function describeResponseValue(kind: string, value: string): string {
  if (kind === "checkbox") return value === "true" ? "✓ checked" : "✗ unchecked";
  if (kind === "signature" || kind === "initials" || kind === "stamp") return "signed";
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

type AckField = { label: string; kind: string; responses: { recipientId: string; value: string; filledAt: Date }[] };

/**
 * A "Shared field acknowledgements" page for the certificate. A shared field
 * (recipientId null) has one placed position, so the stamped document shows only
 * the first signer's value — every signer's own answer lives in
 * SignatureFieldResponse. Record all of them here so the sealed PDF's audit
 * pages, not just the live hub, carry the full acknowledgement trail. Returns ""
 * (no page) when there are no shared responses.
 */
function acknowledgementsHtml(fields: AckField[], nameById: Map<string, string>): string {
  if (fields.length === 0) return "";
  const blocks = fields.map((f) => {
    const items = f.responses.map((r) => {
      const who = esc(nameById.get(r.recipientId) ?? "Unknown recipient");
      const when = r.filledAt ? esc(formatDateTime(r.filledAt)) : "—";
      return `<li style="font-size:9pt;color:#334155;margin:2px 0"><strong>${who}</strong> · ${esc(describeResponseValue(f.kind, r.value))} <span style="color:#94a3b8">· ${when}</span></li>`;
    }).join("");
    return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:10px 0">
      <div style="font-size:10pt;font-weight:600;color:#020617;margin-bottom:6px">${esc(f.label || f.kind)}</div>
      <ul style="margin:0;padding-left:16px">${items}</ul>
    </div>`;
  }).join("");
  return `<div style="page-break-before:always;padding-top:6px">
    <h1 style="font-size:18pt;color:#020617;margin:0 0 4px">Shared field acknowledgements</h1>
    <p style="color:#64748b;font-size:10pt;margin:0 0 12px">Each signer’s response to a field any recipient could complete. The document stamps the first; all are recorded here.</p>
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
  const ctx = await bindCtx(req.quoteId, req.jobCardId);

  const rows: RecipientRow[] = [];
  for (const r of req.recipients.filter((x) => x.status === "signed")) {
    rows.push({ name: r.signedName || r.name, role: r.role, signedAt: r.signedAt, signerIp: r.signerIp, img: await sigImg(r.signatureRef) });
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
  const sharedResponseFields = await prisma.signatureField.findMany({
    where: { requestId, recipientId: null, responses: { some: {} } },
    include: { responses: { orderBy: { filledAt: "asc" } } },
  });
  const ackFields: AckField[] = sharedResponseFields.map((f) => ({
    label: f.label,
    kind: f.kind,
    responses: f.responses.map((r) => ({ recipientId: r.recipientId, value: r.value, filledAt: r.filledAt })),
  }));

  const html = renderDocumentHtml(doc, ctx, logoDataUri(), {
    hideOverlays: true,
    stampedFields,
    appendHtml: certificateHtml(req.title, req.id, rows) + acknowledgementsHtml(ackFields, nameByRecipient),
  });
  let pdf = await htmlToPdf(html);
  pdf = await sealPdf(pdf, { reason: `Signed: ${req.title}`, name: "Denago Cape Town" });
  const hash = crypto.createHash("sha256").update(pdf).digest("hex");
  const storedName = await saveFile(pdf, `${req.title} (signed).pdf`, "application/pdf");

  // No creator recorded → attribute the signed Document to a member of THIS
  // request's tenant, never the global oldest user (resolveTenantActor).
  const uploaderId = req.createdById || (await resolveTenantActor())?.id;
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
        data: { status: "completed", completedAt: new Date(), signedPdfRef: storedName, signedPdfHash: hash, signedDocId: document?.id ?? null },
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
          data: { signedAt: new Date(), signedByName: signerName },
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
    await deleteFile(storedName).catch(() => {});
    if (err instanceof CompletionLost || err instanceof SourceCompletionLost) return;
    throw err;
  }

  await logSignEvent(requestId, { type: "completed", actor: "system", metadata: { hash } });

  // External fan-out only (referral, automations, push, audit). The core source
  // state is already committed above; this is best-effort and never unwinds it.
  await runPostCompletion({
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

  // Email the sealed PDF to every recipient with an address.
  for (const r of req.recipients) {
    if (!r.email) continue;
    await sendEmail({
      to: r.email, subject: `Completed & signed: ${req.title}`,
      text: `Hi ${r.name},\n\nEveryone has signed "${req.title}". The final sealed PDF is attached.\n\nDenago Cape Town`,
      attachments: [{ filename: `${req.title}.pdf`, content: pdf, contentType: "application/pdf" }],
    });
  }
}
