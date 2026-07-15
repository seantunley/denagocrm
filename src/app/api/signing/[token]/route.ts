import { z } from "zod";
import { prisma } from "@/lib/db";
import { saveFile } from "@/lib/storage";
import { isValidSignToken } from "@/lib/signing/tokens";
import { logSignEvent, reqMeta } from "@/lib/signing/events";
import { advanceAfterSignature } from "@/lib/signing/workflow";
import { logAudit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const bodySchema = z.object({
  name: z.string().min(2).max(120),
  consent: z.literal(true),
  fields: z.array(z.object({ id: z.string(), value: z.string().max(800000) })).default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });

  const recipient = await prisma.signatureRecipient.findUnique({ where: { token }, include: { request: true } });
  if (!recipient) return new Response("Not found", { status: 404 });
  const request = recipient.request;
  if (request.deletedAt || request.status === "voided" || request.status === "completed") return new Response("This document can no longer be signed.", { status: 409 });
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.role === "viewer") return new Response("View only", { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid submission", { status: 400 });
  const { name, fields } = parsed.data;
  const meta = await reqMeta();

  const requestFields = await prisma.signatureField.findMany({ where: { requestId: request.id } });
  const fillable = new Map(requestFields.filter((f) => f.recipientId === recipient.id || f.recipientId === null).map((f) => [f.id, f]));

  let signatureRef: string | null = null;
  for (const f of fields) {
    const fieldRow = fillable.get(f.id);
    if (!fieldRow) continue;
    let value = f.value;
    if ((fieldRow.kind === "signature" || fieldRow.kind === "initials" || fieldRow.kind === "stamp") && value.startsWith("data:image/")) {
      const b64 = value.split(",")[1] ?? "";
      const ref = await saveFile(Buffer.from(b64, "base64"), `signature-${recipient.id}.png`, "image/png");
      value = ref;
      if (fieldRow.kind === "signature" && !signatureRef) signatureRef = ref;
    }
    await prisma.signatureField.update({ where: { id: f.id }, data: { value, filledAt: new Date() } });
    await logSignEvent(request.id, { type: "field_filled", recipientId: recipient.id, actor: name, channel: "web", metadata: { kind: fieldRow.kind } });
  }

  // Atomic claim prevents a double-sign race.
  const claimed = await prisma.signatureRecipient.updateMany({
    where: { id: recipient.id, status: { not: "signed" } },
    data: { status: "signed", signedAt: new Date(), signedName: name, signatureRef, signerIp: meta.ip, signerUserAgent: meta.ua },
  });
  if (claimed.count === 0) return new Response("Already signed", { status: 409 });

  await logSignEvent(request.id, { type: "signed", recipientId: recipient.id, actor: name, channel: "web", ip: meta.ip, userAgent: meta.ua });
  // Surface the signature on the customer's timeline (audit feed). logSignEvent
  // only writes to SignatureEvent, which the contact/lead timelines don't read.
  const auditLead = request.quoteId
    ? (await prisma.quote.findUnique({ where: { id: request.quoteId }, select: { leadId: true } }))?.leadId ?? null
    : null;
  await logAudit({
    action: "signing.signed",
    summary: `${name} signed “${request.title}”`,
    contactId: request.contactId,
    leadId: auditLead,
    userName: name,
    entityType: "SignatureRequest",
    entityId: request.id,
  });
  await advanceAfterSignature(request.id);

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
