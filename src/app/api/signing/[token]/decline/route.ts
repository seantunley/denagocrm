import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { logSignEvent, reqMeta } from "@/lib/signing/events";
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
  if (recipient.request.status === "completed" || recipient.request.status === "voided") return new Response("Closed", { status: 409 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason : "";
  const meta = await reqMeta();

  await prisma.signatureRecipient.update({ where: { id: recipient.id }, data: { status: "declined", declinedAt: new Date(), declineReason: reason || null } });
  await prisma.signatureRequest.update({ where: { id: recipient.requestId }, data: { status: "declined", declinedAt: new Date() } });
  await logSignEvent(recipient.requestId, { type: "declined", recipientId: recipient.id, actor: recipient.name, channel: "web", ip: meta.ip, userAgent: meta.ua, metadata: { reason } });
  await notifyCreatorDeclined(recipient.requestId, recipient.name, reason);

  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}
