import "server-only";
import crypto from "crypto";
import { headers } from "next/headers";
import { prisma } from "@/lib/db";
// The hash format lives in a module with no server binding, so evidence can be
// verified by anything holding an export — not only by the system that wrote it.
import { signEventPayloadHash, type SignEventInput } from "./evidenceHash";

export async function reqMeta(): Promise<{ ip: string | null; ua: string | null }> {
  try {
    const h = await headers();
    return { ip: (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || null, ua: h.get("user-agent") };
  } catch { return { ip: null, ua: null }; }
}

/**
 * Build the row for an evidence event, including its content hash.
 *
 * `id` and `createdAt` are set HERE rather than left to the database, because
 * both are inputs to the hash: a value the database chose after the hash was
 * computed could not be covered by it. Everything else about the chain —
 * position, previous hash, and the link hash itself — is assigned by the trigger
 * on insert, which is the only place that can do it without a race.
 */
export function buildSignEvent(requestId: string, e: {
  type: string; recipientId?: string | null; actor: string; channel?: string | null;
  ip?: string | null; userAgent?: string | null; metadata?: object;
}) {
  const id = `sev_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date();
  const row: SignEventInput = {
    id,
    requestId,
    recipientId: e.recipientId ?? null,
    type: e.type,
    actor: e.actor,
    channel: e.channel ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    metadata: e.metadata ?? {},
    createdAt,
  };
  return {
    id,
    requestId,
    recipientId: row.recipientId,
    type: row.type,
    actor: row.actor,
    channel: row.channel,
    ip: row.ip,
    userAgent: row.userAgent,
    metadata: (e.metadata ?? {}) as object,
    createdAt,
    payloadHash: signEventPayloadHash(row),
  };
}

export async function logSignEvent(requestId: string, e: {
  type: string; recipientId?: string | null; actor: string; channel?: string | null; ip?: string | null; userAgent?: string | null; metadata?: object;
}): Promise<void> {
  await prisma.signatureEvent.create({ data: buildSignEvent(requestId, e) });
}

/** First-view bookkeeping — logs an "opened" event once and advances status. */
export async function recordView(recipientId: string, requestId: string, name: string): Promise<void> {
  const r = await prisma.signatureRecipient.findUnique({ where: { id: recipientId }, select: { viewedAt: true, status: true } });
  if (r?.viewedAt) return; // already recorded
  const meta = await reqMeta();
  await prisma.signatureRecipient.update({
    where: { id: recipientId },
    data: { viewedAt: new Date(), status: r?.status === "pending" || r?.status === "sent" ? "viewed" : r?.status ?? "viewed" },
  });
  await logSignEvent(requestId, { type: "opened", recipientId, actor: name, channel: "web", ip: meta.ip, userAgent: meta.ua });
  await prisma.signatureRequest.updateMany({ where: { id: requestId, status: { in: ["sent", "draft"] } }, data: { status: "viewed" } });
}

export { signEventPayloadHash, canonicalJson, verifyEvidenceChain } from "./evidenceHash";
export type { SignEventInput } from "./evidenceHash";
