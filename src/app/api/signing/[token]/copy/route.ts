import { prisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta, logSignEvent } from "@/lib/signing/events";
import { deliverCompletionEmails } from "@/lib/signing/completionFanout";
import { exactTenantWhere } from "@/lib/signing/recoveryScope";
import { automationOn } from "@/lib/automationSwitch";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenantForNotice } from "@/lib/tokenTenant";
import { rateLimitSigning } from "@/lib/signing/throttle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Written before each send, so it is also what the limits below count. */
const COPY_REQUESTED_EVENT = "signed_copy_requested";
const COOLDOWN_MS = 10 * 60 * 1000;
/** Per signer, for good. Past this it is a conversation with the sender, not a button. */
const MAX_REQUESTS = 10;

/**
 * "Send my copy again", from a signing link whose document is complete.
 *
 * The link is already revoked by then, which is why this resolves it with the
 * NOTICE resolver — and why it does so little. It takes no input at all: the
 * signed PDF goes to the email address on file for the signer this link belonged
 * to, never to anything the caller supplies and never back in the response. So
 * holding somebody's old link gets you, at most, a copy sent to THEM.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await rateLimitSigning(token);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenantForNotice(token),
    () => resendCopy(token),
    () => new Response("Not found", { status: 404 }),
  );
}

async function resendCopy(token: string): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    include: { request: true },
  });
  if (!recipient || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const request = recipient.request;
  if (request.deletedAt || request.status !== "completed" || !request.signedPdfRef) {
    return new Response("There is no signed copy to send for this document.", { status: 409 });
  }
  // The same switch that decides whether a signed copy is emailed at all. Off
  // means the workspace hands copies over itself, and this must not email one
  // behind its back.
  if (!recipient.email || !(await automationOn("SIGNING_SIGNED_COPIES", recipient.tenantId).catch(() => false))) {
    return new Response("Please contact the sender for your signed copy.", { status: 409 });
  }

  const earlier = await prisma.signatureEvent.findMany({
    where: { requestId: request.id, recipientId: recipient.id, type: COPY_REQUESTED_EVENT },
    orderBy: { createdAt: "desc" },
    take: MAX_REQUESTS,
    select: { createdAt: true },
  });
  if (earlier.length >= MAX_REQUESTS) {
    return new Response("Please contact the sender for your signed copy.", { status: 429 });
  }
  if (earlier[0] && Date.now() - earlier[0].createdAt.getTime() < COOLDOWN_MS) {
    return new Response("We sent it a few minutes ago. Please check your inbox and your spam folder.", { status: 429 });
  }

  let pdf: Buffer;
  try {
    pdf = await readFile(request.signedPdfRef, request.tenantId);
  } catch {
    return new Response("Your copy could not be prepared. Please contact the sender.", { status: 503 });
  }

  const meta = await reqMeta();
  await logSignEvent(request.id, {
    type: COPY_REQUESTED_EVENT,
    recipientId: recipient.id,
    actor: recipient.name,
    channel: "web",
    ip: meta.ip,
    userAgent: meta.ua,
  });
  const delivery = await deliverCompletionEmails({
    requestId: request.id,
    title: request.title,
    pdf,
    // Null, so it is sent again: "already has it" is the very thing being asked about.
    recipients: [{ id: recipient.id, name: recipient.name, email: recipient.email, completedEmailSentAt: null }],
    tenantWhere: exactTenantWhere(request.tenantId),
  });
  if (!delivery.ok) return new Response("We could not send your copy just now. Please try again later.", { status: 502 });
  return Response.json({ ok: true });
}
