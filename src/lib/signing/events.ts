import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { signingReleaseId } from "./securityConfig";

export async function reqMeta(): Promise<{ ip: string | null; ua: string | null }> {
  try {
    const h = await headers();
    return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null, ua: h.get("user-agent") };
  } catch { return { ip: null, ua: null }; }
}

export async function logSignEvent(requestId: string, event: {
  type: string; recipientId?: string | null; actor: string; channel?: string | null;
  ip?: string | null; userAgent?: string | null; metadata?: object;
}): Promise<void> {
  const request = await prisma.signatureRequest.findUnique({ where: { id: requestId }, select: { tenantId: true } });
  if (!request?.tenantId) throw new Error("Cannot append signing evidence without a tenant-owned envelope");
  await prisma.signatureEvent.create({
    data: {
      tenantId: request.tenantId,
      requestId,
      recipientId: event.recipientId ?? null,
      type: event.type,
      actor: event.actor,
      channel: event.channel ?? null,
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
      metadata: { ...(event.metadata ?? {}), releaseId: signingReleaseId() },
    },
  });
}

export async function recordView(recipientId: string, requestId: string, name: string): Promise<void> {
  const recipient = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, select: { viewedAt: true, status: true } });
  if (recipient?.viewedAt) return;
  const meta = await reqMeta();
  await prisma.$transaction(async (tx) => {
    await tx.signatureRecipient.update({
      where: { id: recipientId },
      data: { viewedAt: new Date(), status: recipient?.status === "pending" || recipient?.status === "sent" ? "viewed" : recipient?.status ?? "viewed" },
    });
    await tx.$executeRaw`UPDATE "SignatureRecipient" SET "firstViewedAt"=COALESCE("firstViewedAt",now()) WHERE id=${recipientId}`;
    await tx.signatureEvent.create({
      data: { requestId, recipientId, type: "opened", actor: name, channel: "web", ip: meta.ip, userAgent: meta.ua },
    });
    await tx.signatureRequest.updateMany({ where: { id: requestId, status: { in: ["sent", "draft", "active"] } }, data: { status: "viewed" } });
  });
}
