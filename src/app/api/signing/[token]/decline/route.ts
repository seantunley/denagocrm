import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { logSignEvent, reqMeta } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { notifyCreatorDeclined } from "@/lib/signing/notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().max(2000).default("") });

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });

  const recipient = await prisma.signatureRecipient.findUnique({ where: { token }, include: { request: true } });
  if (!recipient) return new Response("Not found", { status: 404 });
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("Already declined", { status: 409 });
  if (recipient.request.deletedAt || isRequestClosed(recipient.request.status)) return new Response("Closed", { status: 409 });
  if (recipient.request.expiresAt && recipient.request.expiresAt < new Date()) return new Response("This signing link has expired.", { status: 409 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason : "";
  const meta = await reqMeta();

  // One transaction that locks the request FOR UPDATE, re-checks it isn't already
  // voided/completed, claims the recipient decline, and sets the request declined
  // — all together. This stops a concurrent staff void from being silently
  // overwritten by a decline (and vice-versa).
  let aborted: string | null = null;
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string; deletedAt: Date | null; expiresAt: Date | null }[]>`
      SELECT "status", "deletedAt", "expiresAt" FROM "SignatureRequest" WHERE "id" = ${recipient.requestId} FOR UPDATE`;
    const r = rows[0];
    if (!r || r.deletedAt || isRequestClosed(r.status)) { aborted = "Closed"; return; }
    if (r.expiresAt && r.expiresAt < new Date()) { aborted = "This signing link has expired."; return; }
    const claimed = await tx.signatureRecipient.updateMany({
      where: { id: recipient.id, status: { notIn: ["signed", "declined"] } },
      data: { status: "declined", declinedAt: new Date(), declineReason: reason || null },
    });
    if (claimed.count === 0) { aborted = "Already actioned"; return; }
    await tx.signatureRequest.update({ where: { id: recipient.requestId }, data: { status: "declined", declinedAt: new Date() } });
  });
  if (aborted) return new Response(aborted, { status: 409 });
  await logSignEvent(recipient.requestId, { type: "declined", recipientId: recipient.id, actor: recipient.name, channel: "web", ip: meta.ip, userAgent: meta.ua, metadata: { reason } });
  await notifyCreatorDeclined(recipient.requestId, recipient.name, reason);

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
