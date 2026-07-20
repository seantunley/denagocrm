import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml, type StampField } from "@/lib/doceditor/serialize";
import { htmlToPdf } from "@/lib/customDocs";
import { sealPdf } from "@/lib/pdf/seal";
import { saveFile, readFile } from "@/lib/storage";
import { sendEmail } from "@/lib/email";
import { formatDateTime } from "@/lib/format";
import { bindCtx, logoDataUri } from "./render";
import { logSignEvent } from "./events";
import { runPostCompletion } from "./postComplete";

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
  if (!req || req.status === "completed" || req.status === "voided" || req.status === "declined") return;
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

  const html = renderDocumentHtml(doc, ctx, logoDataUri(), { hideOverlays: true, stampedFields, appendHtml: certificateHtml(req.title, req.id, rows) });
  let pdf = await htmlToPdf(html);
  pdf = await sealPdf(pdf, { reason: `Signed: ${req.title}`, name: "Denago Cape Town" });
  const hash = crypto.createHash("sha256").update(pdf).digest("hex");
  const storedName = await saveFile(pdf, `${req.title} (signed).pdf`, "application/pdf");

  const uploaderId = req.createdById || (await prisma.user.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }))?.id;
  const document = uploaderId
    ? await prisma.document.create({
        data: {
          fileName: `${req.title} (signed).pdf`, storedName, mimeType: "application/pdf", sizeBytes: pdf.length,
          quoteId: req.quoteId, jobCardId: req.jobCardId, contactId: req.contactId, tag: "signed", uploadedById: uploaderId,
        },
      })
    : null;

  // Conditionally claim completion: only transition a still-open request. If a
  // concurrent void/decline closed it after our initial read, count === 0 and we
  // abort BEFORE running post-completion or emailing the sealed PDF — otherwise a
  // caller could receive a successful "voided" result while the document is still
  // distributed as completed. Drop the signed document we optimistically created.
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: { notIn: ["completed", "voided", "declined"] } },
    data: { status: "completed", completedAt: new Date(), signedPdfRef: storedName, signedPdfHash: hash, signedDocId: document?.id ?? null },
  });
  if (claimed.count === 0) {
    if (document) await prisma.document.delete({ where: { id: document.id } }).catch(() => {});
    return;
  }
  await logSignEvent(requestId, { type: "completed", actor: "system", metadata: { hash } });

  // Fire CRM side-effects (quote accepted → lead won, job card signed). Parity
  // with the legacy /sign flow. Best-effort: never unwinds the completed request.
  const firstSigner = req.recipients.find((r) => r.status === "signed" && r.role !== "viewer");
  await runPostCompletion({
    id: req.id,
    title: req.title,
    quoteId: req.quoteId,
    jobCardId: req.jobCardId,
    signedByName: firstSigner?.signedName || firstSigner?.name || null,
    signedPdfHash: hash,
    signedDocId: document?.id ?? null,
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
