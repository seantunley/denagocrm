import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { parseDocument } from "@/lib/doceditor/model";
import { renderDocumentHtml } from "@/lib/doceditor/serialize";
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
  if (!req || req.status === "completed") return;
  const doc = parseDocument(req.snapshotJson);
  if (!doc) return;
  const ctx = await bindCtx(req.quoteId, req.jobCardId);

  const rows: RecipientRow[] = [];
  for (const r of req.recipients.filter((x) => x.status === "signed")) {
    rows.push({ name: r.signedName || r.name, role: r.role, signedAt: r.signedAt, signerIp: r.signerIp, img: await sigImg(r.signatureRef) });
  }

  const html = renderDocumentHtml(doc, ctx, logoDataUri(), { hideOverlays: true, appendHtml: certificateHtml(req.title, req.id, rows) });
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

  await prisma.signatureRequest.update({
    where: { id: requestId },
    data: { status: "completed", completedAt: new Date(), signedPdfRef: storedName, signedPdfHash: hash, signedDocId: document?.id ?? null },
  });
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
