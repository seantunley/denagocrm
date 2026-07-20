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
  // The signing PAGE enforced these; the API must repeat every one — a direct
  // POST bypasses the page entirely.
  if (request.deletedAt || request.status === "voided" || request.status === "completed" || request.status === "declined") {
    return new Response("This document can no longer be signed.", { status: 409 });
  }
  if (request.expiresAt && request.expiresAt < new Date()) {
    return new Response("This signing link has expired.", { status: 409 });
  }
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("You have declined this document.", { status: 409 });
  if (recipient.role === "viewer") return new Response("View only", { status: 403 });

  // Sequential workflows: block a later signer until every earlier, non-viewer
  // recipient has signed (the page's "Not your turn yet" rule).
  if (request.ordering === "sequential") {
    const earlier = await prisma.signatureRecipient.findFirst({
      where: { requestId: request.id, role: { not: "viewer" }, order: { lt: recipient.order }, status: { not: "signed" } },
      select: { id: true },
    });
    if (earlier) return new Response("It's not your turn to sign yet.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("Invalid submission", { status: 400 });
  const { name, fields } = parsed.data;
  const meta = await reqMeta();

  const requestFields = await prisma.signatureField.findMany({ where: { requestId: request.id } });
  const fillable = new Map(requestFields.filter((f) => f.recipientId === recipient.id || f.recipientId === null).map((f) => [f.id, f]));

  // Required-field validation: every required field this recipient must fill has
  // to arrive with a value (or already be filled). The page enforced this
  // client-side; the API must too.
  const submitted = new Map(fields.filter((f) => f.value && f.value.trim() !== "").map((f) => [f.id, f.value]));
  const missingRequired = [...fillable.values()].some((f) => f.required && !f.filledAt && !submitted.has(f.id));
  if (missingRequired) {
    return new Response("Please complete all required fields before signing.", { status: 400 });
  }

  // Claim the recipient FIRST, atomically — before writing any field values or
  // signature files. A losing race (or an already-signed/declined recipient)
  // fails here and mutates nothing; the old order persisted fields/images before
  // this guard, so a loser could overwrite the winner's field values.
  const claimed = await prisma.signatureRecipient.updateMany({
    where: { id: recipient.id, status: { notIn: ["signed", "declined"] } },
    data: { status: "signed", signedAt: new Date(), signedName: name, signerIp: meta.ip, signerUserAgent: meta.ua },
  });
  if (claimed.count === 0) return new Response("Already signed", { status: 409 });

  // We own the claim — now persist field values + signature images. Decode/store
  // images first, then commit all field writes (and the recipient's signatureRef)
  // in one transaction so they land together.
  let signatureRef: string | null = null;
  const filledAt = new Date();
  const updates: { id: string; value: string; kind: string }[] = [];
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
    updates.push({ id: f.id, value, kind: fieldRow.kind });
  }
  await prisma.$transaction([
    ...updates.map((u) => prisma.signatureField.update({ where: { id: u.id }, data: { value: u.value, filledAt } })),
    ...(signatureRef ? [prisma.signatureRecipient.update({ where: { id: recipient.id }, data: { signatureRef } })] : []),
  ]);
  for (const u of updates) {
    await logSignEvent(request.id, { type: "field_filled", recipientId: recipient.id, actor: name, channel: "web", metadata: { kind: u.kind } });
  }

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
