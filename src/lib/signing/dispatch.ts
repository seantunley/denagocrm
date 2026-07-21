import "server-only";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { sendWhatsAppText, waDigits, isWhatsAppConfigured } from "@/lib/whatsapp";
import { logSignEvent } from "./events";
import { CLOSED_REQUEST_STATUSES, isRequestClosed } from "./status";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";

export function signUrl(token: string): string {
  return `${BASE}/signing/${token}`;
}

function emailHtml(name: string, title: string, url: string, verb: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1e293b">
    <div style="font-weight:800;letter-spacing:1px">DENAGO <span style="color:#ea580c">CAPE TOWN</span></div>
    <h2 style="font-size:18px;margin:18px 0 6px">${verb}</h2>
    <p>Hi ${escapeText(name)},</p>
    <p>Please review and sign <strong>${escapeText(title)}</strong>.</p>
    <p style="margin:22px 0"><a href="${url}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Open &amp; sign</a></p>
    <p style="font-size:12px;color:#64748b">Or paste this link into your browser:<br>${url}</p>
    <p style="font-size:12px;color:#94a3b8;margin-top:20px">Denago Cape Town — Authorised Denago EV Dealer</p>
  </div>`;
}
function escapeText(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/** Notify one recipient (email + WhatsApp best-effort). Marks them "sent". */
export async function notifyRecipient(recipientId: string, opts?: { reminder?: boolean }): Promise<void> {
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: true } });
  if (!r || r.role === "viewer") return;
  // Never notify for a CLOSED request, or a recipient who already
  // signed/declined — the request can close (void/decline/expire/reject/
  // complete) between dispatch's claim and this external email/WhatsApp send.
  if (isRequestClosed(r.request.status)) return;
  if (r.status === "signed" || r.status === "declined") return;
  const url = signUrl(r.token);
  const verb = opts?.reminder ? "Reminder — please sign" : "Please sign your document";
  const evType = opts?.reminder ? "reminded" : "sent";

  if (r.email) {
    const res = await sendEmail({
      to: r.email, subject: `${verb}: ${r.request.title}`,
      text: `Hi ${r.name},\n\n${verb}: "${r.request.title}" from Denago Cape Town.\n\nOpen and sign here:\n${url}\n\nThank you,\nDenago Cape Town`,
      html: emailHtml(r.name, r.request.title, url, verb),
    });
    await logSignEvent(r.requestId, { type: evType, recipientId: r.id, actor: "system", channel: "email", metadata: { ok: res.ok, error: res.error } });
  }
  // WhatsApp works inside the 24h customer-service window (or requires an approved
  // template for cold outreach — see @/lib/whatsapp). Best-effort; failures are logged.
  if (r.phone && (await isWhatsAppConfigured())) {
    const res = await sendWhatsAppText(waDigits(r.phone), `${verb}: "${r.request.title}"\nSign here: ${url}`);
    await logSignEvent(r.requestId, { type: evType, recipientId: r.id, actor: "system", channel: "whatsapp", metadata: { ok: res.ok, error: res.error } });
  }

  await prisma.signatureRecipient.updateMany({ where: { id: r.id, status: "pending" }, data: { status: "sent" } });
  if (opts?.reminder) await prisma.signatureRecipient.update({ where: { id: r.id }, data: { remindedAt: new Date() } });
}

/** Send the request: mark sent, and notify the right recipients for the ordering. */
export async function dispatchRequest(requestId: string): Promise<{ notified: number }> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req) return { notified: 0 };
  // CONDITIONALLY claim the (re)send: only move a still-open request to "sent".
  // A read-check + unconditional update was a TOCTOU — a concurrent void/decline
  // could close the request between the two, and the unconditional update would
  // force it back to "sent", resurrecting a dead signing link and re-notifying
  // declined recipients. count !== 1 → it just closed; do nothing.
  const claimed = await prisma.signatureRequest.updateMany({
    where: { id: requestId, status: { notIn: [...CLOSED_REQUEST_STATUSES] } },
    data: { status: "sent", sentAt: req.sentAt ?? new Date() },
  });
  if (claimed.count !== 1) return { notified: 0 };

  const signers = req.recipients.filter((r) => r.role !== "viewer" && r.status !== "signed");
  const targets = req.ordering === "sequential" ? signers.slice(0, 1) : signers;
  for (const r of targets) await notifyRecipient(r.id);
  // NOTE: viewers are intentionally NOT notified here. notifyRecipient() returns
  // early for viewers (they never sign), so the previous per-viewer loop was dead
  // code. If viewer "for your records" copies are wanted, add a dedicated path.
  return { notified: targets.length };
}

/** After someone signs (sequential): notify the next unsigned signer, if any. */
export async function notifyNextInSequence(requestId: string): Promise<void> {
  const req = await prisma.signatureRequest.findUnique({ where: { id: requestId }, include: { recipients: { orderBy: { order: "asc" } } } });
  if (!req || req.ordering !== "sequential") return;
  const next = req.recipients.find((r) => r.role !== "viewer" && r.status !== "signed");
  if (next && next.status !== "sent" && next.status !== "viewed") await notifyRecipient(next.id);
  else if (next && !next.viewedAt) await notifyRecipient(next.id);
}
