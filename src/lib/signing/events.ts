import "server-only";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
import { emitJourneyEvent } from "@/lib/journeyEvents";

export async function reqMeta(): Promise<{ ip: string | null; ua: string | null }> {
  try {
    const h = await headers();
    return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null, ua: h.get("user-agent") };
  } catch { return { ip: null, ua: null }; }
}

export async function logSignEvent(requestId: string, e: {
  type: string; recipientId?: string | null; actor: string; channel?: string | null; ip?: string | null; userAgent?: string | null; metadata?: object;
}): Promise<void> {
  await prisma.signatureEvent.create({
    data: {
      requestId, recipientId: e.recipientId ?? null, type: e.type, actor: e.actor,
      channel: e.channel ?? null, ip: e.ip ?? null, userAgent: e.userAgent ?? null,
      metadata: (e.metadata ?? undefined) as object | undefined,
    },
  });
}

/** First-view bookkeeping — logs an opened event once and advances status. */
export async function recordView(recipientId: string, requestId: string, name: string): Promise<void> {
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, select: { viewedAt: true, status: true } });
  if (r?.viewedAt) return;
  const meta = await reqMeta();
  await prisma.signatureRecipient.update({
    where: { id: recipientId },
    data: { viewedAt: new Date(), status: r?.status === "pending" || r?.status === "sent" ? "viewed" : r?.status ?? "viewed" },
  });
  await logSignEvent(requestId, { type: "opened", recipientId, actor: name, channel: "web", ip: meta.ip, userAgent: meta.ua });
  await prisma.signatureRequest.updateMany({ where: { id: requestId, status: { in: ["sent", "draft"] } }, data: { status: "viewed" } });

  const request = await prisma.signatureRequest.findUnique({
    where: { id: requestId },
    select: { id: true, title: true, quoteId: true, contactId: true },
  });
  if (!request?.quoteId) return;
  const quote = await prisma.quote.findUnique({
    where: { id: request.quoteId },
    select: { id: true, number: true, leadId: true, contactId: true, status: true },
  });
  if (!quote) return;
  const entityType = quote.leadId ? "lead" : quote.contactId || request.contactId ? "contact" : "system";
  const entityId = quote.leadId ?? quote.contactId ?? request.contactId ?? quote.id;
  await emitJourneyEvent({
    type: "quote_opened",
    entityType,
    entityId,
    payload: { source: { id: quote.id, entityType: "Quote", reference: `Q-${quote.number}`, status: quote.status, signatureRequestId: request.id, title: request.title } },
    dedupeKey: `quote-opened:${request.id}`,
  });
}
