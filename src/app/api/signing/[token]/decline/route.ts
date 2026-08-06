import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { logSignEvent, reqMeta } from "@/lib/signing/events";
import { isRequestClosed, isRequestProcessing } from "@/lib/signing/status";
import { notifyCreatorDeclined } from "@/lib/signing/notify";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().max(2000).default("") });
const unavailable = (status: string) => isRequestClosed(status) || isRequestProcessing(status);

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handleDecline(token, req),
    () => new Response("Not found", { status: 404 }),
  );
}

async function handleDecline(token: string, req: Request): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({ where: { token: hashSignToken(token) }, include: { request: true } });
  if (!recipient) return new Response("Not found", { status: 404 });
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("Already declined", { status: 409 });
  if (recipient.request.deletedAt || unavailable(recipient.request.status)) return new Response("This document can no longer be declined.", { status: 409 });
  if (recipient.request.expiresAt && recipient.request.expiresAt < new Date()) return new Response("This signing link has expired.", { status: 409 });
  if (recipient.request.workflowGraphJson && (!recipient.nodeId || recipient.nodeId !== recipient.request.currentNodeId)) {
    return new Response("This workflow has not reached your step.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason : "";
  const meta = await reqMeta();

  let aborted: string | null = null;
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{
      status: string;
      deletedAt: Date | null;
      expiresAt: Date | null;
      hasWorkflow: boolean;
      currentNodeId: string | null;
    }>>(Prisma.sql`
      SELECT status,"deletedAt","expiresAt",("workflowGraphJson" IS NOT NULL) AS "hasWorkflow","currentNodeId"
        FROM "SignatureRequest" WHERE id=${recipient.requestId} FOR UPDATE
    `);
    const request = rows[0];
    if (!request || request.deletedAt || unavailable(request.status)) { aborted = "This document can no longer be declined."; return; }
    if (request.expiresAt && request.expiresAt < new Date()) { aborted = "This signing link has expired."; return; }
    if (request.hasWorkflow && (!recipient.nodeId || recipient.nodeId !== request.currentNodeId)) {
      aborted = "This workflow has not reached your step.";
      return;
    }
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
