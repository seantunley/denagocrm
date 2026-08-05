import { z } from "zod";
import { prisma } from "@/lib/db";
import { isValidSignToken } from "@/lib/signing/tokens";
import { reqMeta } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { loadRecipientIdentity, identityStatus } from "@/lib/signing/identity";
import { notifyCreatorDeclined } from "@/lib/signing/notify";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ reason: z.string().trim().max(2000).default("") }).strict();

class DeclineAbort extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

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
  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({ where: { token }, include: { request: true } }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const assurance = identityStatus(identity);
  if (assurance.required && !assurance.verified) {
    return new Response("Verify your identity before declining.", { status: 403 });
  }
  if (recipient.status === "signed") return new Response("Already signed", { status: 409 });
  if (recipient.status === "declined") return new Response("Already declined", { status: 409 });
  if (recipient.request.deletedAt || isRequestClosed(recipient.request.status)) return new Response("Closed", { status: 409 });
  if (recipient.request.expiresAt && recipient.request.expiresAt < new Date()) {
    return new Response("This signing link has expired.", { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return new Response("Invalid request", { status: 400 });
  const reason = parsed.data.reason;
  const meta = await reqMeta();
  const decidedAt = new Date();

  try {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{
        status: string;
        deletedAt: Date | null;
        expiresAt: Date | null;
        identityMode: string;
      }>>`
        SELECT "status", "deletedAt", "expiresAt", "identityMode"
        FROM "SignatureRequest"
        WHERE "id" = ${recipient.requestId} AND "tenantId" = ${recipient.tenantId}
        FOR UPDATE
      `;
      const request = rows[0];
      if (!request || request.deletedAt || isRequestClosed(request.status)) {
        throw new DeclineAbort(409, "Closed");
      }
      if (request.expiresAt && request.expiresAt < decidedAt) {
        throw new DeclineAbort(409, "This signing link has expired.");
      }

      const locked = await tx.$queryRaw<Array<{ status: string; identityVerifiedAt: Date | null }>>`
        SELECT "status", "identityVerifiedAt"
        FROM "SignatureRecipient"
        WHERE "id" = ${recipient.id}
          AND "requestId" = ${recipient.requestId}
          AND "tenantId" = ${recipient.tenantId}
        FOR UPDATE
      `;
      if (!locked[0] || ["signed", "declined"].includes(locked[0].status)) {
        throw new DeclineAbort(409, "Already actioned");
      }
      if (request.identityMode !== "link" && !locked[0].identityVerifiedAt) {
        throw new DeclineAbort(403, "Verify your identity before declining.");
      }

      const claimed = await tx.signatureRecipient.updateMany({
        where: {
          id: recipient.id,
          tenantId: recipient.tenantId,
          status: { notIn: ["signed", "declined"] },
        },
        data: { status: "declined", declinedAt: decidedAt, declineReason: reason || null },
      });
      if (claimed.count === 0) throw new DeclineAbort(409, "Already actioned");

      const closed = await tx.signatureRequest.updateMany({
        where: {
          id: recipient.requestId,
          tenantId: recipient.tenantId,
          status: { notIn: ["completed", "declined", "expired", "voided", "rejected"] },
        },
        data: { status: "declined", declinedAt: decidedAt },
      });
      if (closed.count !== 1) throw new DeclineAbort(409, "Closed");

      await tx.signatureEvent.create({
        data: {
          requestId: recipient.requestId,
          recipientId: recipient.id,
          type: "declined",
          actor: recipient.name,
          channel: "web",
          ip: meta.ip,
          userAgent: meta.ua,
          metadata: { reason, identityMode: request.identityMode },
        },
      });
      // Recipient and request triggers enqueue notification recovery and revoke
      // every bearer link in this same commit.
    });
  } catch (error) {
    if (error instanceof DeclineAbort) return new Response(error.message, { status: error.status });
    throw error;
  }

  // Best-effort latency path; the transition outbox retries until the immutable
  // decline_notification_sent marker exists.
  await notifyCreatorDeclined(recipient.requestId, recipient.name, reason).catch(() => ({ ok: false }));
  return Response.json({ ok: true });
}
