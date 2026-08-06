import "server-only";
import { Prisma } from "@prisma/client";
import { prisma, basePrisma } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { sendWhatsAppText, waDigits, isWhatsAppConfigured } from "@/lib/whatsapp";
import { readFile } from "@/lib/storage";
import { decryptSignToken, newSignCapability } from "./tokens";
import { enqueueSigningJob, type SigningOutboxJob } from "./outbox";
import { logSignEvent } from "./events";
import { isRequestClosed } from "./status";

const BASE = process.env.SIGN_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.denagocpt.co.za";
export const signUrl = (rawToken: string) => `${BASE}/signing/${rawToken}`;
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function signingEmailHtml(name: string, title: string, url: string, verb: string): string {
  return `<div style="font-family:Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1e293b">
    <div style="font-weight:800;letter-spacing:1px">DENAGO <span style="color:#ea580c">CAPE TOWN</span></div>
    <h2 style="font-size:18px;margin:18px 0 6px">${escapeText(verb)}</h2>
    <p>Hi ${escapeText(name)},</p><p>Please review and sign <strong>${escapeText(title)}</strong>.</p>
    <p style="margin:22px 0"><a href="${url}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Verify, open &amp; sign</a></p>
    <p style="font-size:12px;color:#64748b">This link is personal. Identity verification may be required. Do not forward it.</p>
  </div>`;
}

type RecipientCapability = { tokenCiphertext: string | null };
export async function ensureRawRecipientToken(recipientId: string): Promise<string> {
  const rows = await basePrisma.$queryRaw<RecipientCapability[]>(Prisma.sql`
    SELECT "tokenCiphertext" FROM "SignatureRecipient" WHERE id=${recipientId} LIMIT 1
  `);
  if (rows[0]?.tokenCiphertext) {
    try { return decryptSignToken(rows[0].tokenCiphertext); }
    catch { /* rotate below */ }
  }
  const capability = newSignCapability();
  const updated = await basePrisma.$executeRaw`
    UPDATE "SignatureRecipient" SET token=${capability.digest},"tokenCiphertext"=${capability.ciphertext},
      "tokenIssuedAt"=${capability.issuedAt},"tokenExpiresAt"=${capability.expiresAt},"tokenRevokedAt"=NULL
    WHERE id=${recipientId} AND status NOT IN ('signed','declined')
  `;
  if (updated !== 1) throw new Error("Recipient capability cannot be rotated");
  return capability.rawToken;
}

export async function queueSigningLinkDeliveries(recipientId: string, reminder = false): Promise<{ jobIds: string[]; reachable: boolean }> {
  const recipient = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, include: { request: true } });
  if (!recipient || recipient.role === "viewer" || isRequestClosed(recipient.request.status)) return { jobIds: [], reachable: false };
  const channels: string[] = [];
  if (recipient.email) channels.push("email");
  if (recipient.phone && await isWhatsAppConfigured()) channels.push("whatsapp");
  if (!channels.length) return { jobIds: [], reachable: false };
  const bucket = reminder ? `reminder:${new Date().toISOString().slice(0, 16)}` : "initial";
  const jobIds = await basePrisma.$transaction(async (tx) => {
    const ids: string[] = [];
    for (const channel of channels) {
      const key = `sign-link:${recipientId}:${channel}:${bucket}`;
      await tx.$executeRaw`
        INSERT INTO "SigningDelivery"("tenantId","envelopeId","recipientId",channel,purpose,"idempotencyKey")
        VALUES (${recipient.tenantId},${recipient.requestId},${recipient.id},${channel},${reminder ? "signing_reminder" : "signing_request"},${key})
        ON CONFLICT ("idempotencyKey") DO NOTHING
      `;
      const id = await enqueueSigningJob(tx, {
        tenantId: recipient.tenantId!, envelopeId: recipient.requestId, recipientId,
        jobType: "deliver_signing_link", payload: { channel, reminder, deliveryKey: key }, idempotencyKey: `job:${key}`,
      });
      if (id) ids.push(id);
    }
    return ids;
  });
  return { jobIds, reachable: true };
}

async function deliveryRow(key: string): Promise<{ id: string; status: string } | null> {
  const rows = await basePrisma.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT id,status FROM "SigningDelivery" WHERE "idempotencyKey"=${key} LIMIT 1
  `);
  return rows[0] ?? null;
}

export async function performSigningLinkDelivery(job: SigningOutboxJob): Promise<void> {
  if (!job.recipientId || !job.envelopeId) throw new Error("Delivery job is missing recipient/envelope");
  const channel = String(job.payload.channel || "");
  const key = String(job.payload.deliveryKey || "");
  const row = await deliveryRow(key);
  if (!row || ["sent", "delivered", "skipped"].includes(row.status)) return;
  const recipient = await prisma.signatureRecipient.findUnique({ where: { id: job.recipientId }, include: { request: true } });
  if (!recipient || isRequestClosed(recipient.request.status) || ["signed", "declined"].includes(recipient.status)) {
    await basePrisma.$executeRaw`UPDATE "SigningDelivery" SET status='skipped',"updatedAt"=now() WHERE id=${row.id}`;
    return;
  }
  await basePrisma.$executeRaw`UPDATE "SigningDelivery" SET status='sending',attempts=attempts+1,"updatedAt"=now() WHERE id=${row.id}`;
  const rawToken = await ensureRawRecipientToken(recipient.id);
  const url = signUrl(rawToken);
  const reminder = Boolean(job.payload.reminder);
  const verb = reminder ? "Reminder — please verify and sign" : "Please verify and sign your document";
  let ok = false;
  let error: string | undefined;
  if (channel === "email" && recipient.email) {
    const result = await sendEmail({
      to: recipient.email,
      subject: `${verb}: ${recipient.request.title}`,
      text: `Hi ${recipient.name},\n\n${verb}: “${recipient.request.title}”.\n\n${url}\n\nThis link is personal. Do not forward it.\n\nDenago Cape Town`,
      html: signingEmailHtml(recipient.name, recipient.request.title, url, verb),
    });
    ok = result.ok; error = result.error;
  } else if (channel === "whatsapp" && recipient.phone) {
    const result = await sendWhatsAppText(waDigits(recipient.phone), `${verb}: “${recipient.request.title}”\n${url}\nThis link is personal; do not forward it.`);
    ok = result.ok; error = result.error;
  } else error = "Delivery channel is unavailable";

  await basePrisma.$executeRaw`
    UPDATE "SigningDelivery" SET status=${ok ? "sent" : "failed"},"sentAt"=${ok ? new Date() : null},
      "lastError"=${error ?? null},"updatedAt"=now() WHERE id=${row.id}
  `;
  await logSignEvent(recipient.requestId, {
    type: reminder ? "reminded" : "sent", recipientId: recipient.id, actor: "system", channel,
    metadata: { ok, error, deliveryId: row.id },
  });
  if (!ok) throw new Error(error || "Provider rejected signing-link delivery");
  await prisma.signatureRecipient.updateMany({
    where: { id: recipient.id, status: { in: ["pending", "sending"] } },
    data: { status: "sent", sendingAt: null, ...(reminder ? { remindedAt: new Date() } : {}) },
  });
}

export async function performCompletedDelivery(job: SigningOutboxJob): Promise<void> {
  if (!job.recipientId || !job.envelopeId) throw new Error("Completed-delivery job is incomplete");
  const recipient = await prisma.signatureRecipient.findUnique({ where: { id: job.recipientId }, include: { request: true } });
  if (!recipient?.email || !(["sealed", "distributing", "completed"].includes(recipient.request.status)) || !recipient.request.signedPdfRef) return;
  const key = `completed-delivery:${job.envelopeId}:${job.recipientId}`;
  const existing = await deliveryRow(key);
  if (existing && ["sent", "delivered"].includes(existing.status)) return;
  await basePrisma.$executeRaw`
    INSERT INTO "SigningDelivery"("tenantId","envelopeId","recipientId",channel,purpose,status,"idempotencyKey")
    VALUES (${recipient.tenantId},${job.envelopeId},${job.recipientId},'email','completed_copy','sending',${key})
    ON CONFLICT ("idempotencyKey") DO UPDATE SET status='sending',attempts="SigningDelivery".attempts+1,"updatedAt"=now()
  `;
  const pdf = await readFile(recipient.request.signedPdfRef);
  const result = await sendEmail({
    to: recipient.email,
    subject: `Completed & signed: ${recipient.request.title}`,
    text: `Hi ${recipient.name},\n\nThe sealed final copy of “${recipient.request.title}” is attached.\n\nDenago Cape Town`,
    attachments: [{ filename: `${recipient.request.title}.pdf`, content: pdf, contentType: "application/pdf" }],
  });
  await basePrisma.$executeRaw`
    UPDATE "SigningDelivery" SET status=${result.ok ? "sent" : "failed"},"sentAt"=${result.ok ? new Date() : null},
      "lastError"=${result.error ?? null},"updatedAt"=now() WHERE "idempotencyKey"=${key}
  `;
  await logSignEvent(job.envelopeId, {
    type: "completed_copy_delivery", recipientId: job.recipientId, actor: "system", channel: "email",
    metadata: { ok: result.ok, error: result.error },
  });
  if (!result.ok) throw new Error(result.error || "Completed copy delivery failed");
}
