import { prisma } from "@/lib/db";
import { openFileStream } from "@/lib/storage";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta, logSignEvent } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { loadRecipientIdentity, identityStatus } from "@/lib/signing/identity";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { SIGNING_READ_POLICY } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Appended the first time a signer takes a copy — it is evidence they could read it at leisure. */
const DOWNLOADED_EVENT = "document_downloaded";

/**
 * "Download a copy", from the signing page, BEFORE signing.
 *
 * Serves the PDF that was sent for signature — the file frozen when the request
 * was created, not a fresh render — to exactly the person the signing page
 * would show the document to, and to nobody it would not. So every refusal the
 * page makes is made again here, in the same order: a finished or expired
 * request, a signer who has not passed the identity check, someone whose turn
 * it is not, a viewer, a signer who is already done. A route that skipped one of
 * them would be the way round it.
 *
 * The acting resolver, so a revoked link reaches none of this.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await throttlePublic("signing-read", token, SIGNING_READ_POLICY);
  if (throttled) return throttled;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => sendDocument(token),
    () => new Response("Not found", { status: 404 }),
  );
}

async function sendDocument(token: string): Promise<Response> {
  const [recipient, identity] = await Promise.all([
    prisma.signatureRecipient.findUnique({
      where: { token: hashSignToken(token) },
      include: { request: { include: { recipients: { select: { order: true, role: true, status: true } } } } },
    }),
    loadRecipientIdentity(token),
  ]);
  if (!recipient || !identity || !recipient.tenantId) return new Response("Not found", { status: 404 });
  const request = recipient.request;

  if (request.deletedAt || isRequestClosed(request.status) || (request.expiresAt && request.expiresAt < new Date())) {
    return new Response("This document is no longer available from this link.", { status: 409 });
  }
  const assurance = identityStatus(identity);
  if (assurance.required && !assurance.verified) {
    return new Response("Verify your identity before downloading this document.", { status: 403 });
  }
  if (recipient.role === "viewer" || recipient.status === "signed" || recipient.status === "declined") {
    return new Response("This document is not available from this link.", { status: 403 });
  }
  if (
    request.ordering === "sequential" &&
    request.recipients.some((other) => other.order < recipient.order && other.role !== "viewer" && other.status !== "signed")
  ) {
    return new Response("It's not your turn to sign yet.", { status: 409 });
  }
  if (!request.unsignedPdfRef) {
    return new Response("This document can't be downloaded here. Please ask the sender for a copy.", { status: 404 });
  }

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await openFileStream(request.unsignedPdfRef, request.tenantId);
  } catch {
    return new Response("This document could not be prepared. Please ask the sender for a copy.", { status: 503 });
  }

  // Once per signer: the fact that they took a copy is the evidence, not how often.
  const already = await prisma.signatureEvent.findFirst({
    where: { requestId: request.id, recipientId: recipient.id, type: DOWNLOADED_EVENT },
    select: { id: true },
  });
  if (!already) {
    const meta = await reqMeta();
    await logSignEvent(request.id, {
      type: DOWNLOADED_EVENT,
      recipientId: recipient.id,
      actor: recipient.name,
      channel: "web",
      ip: meta.ip,
      userAgent: meta.ua,
    }).catch(() => {});
  }

  return new Response(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${request.title}.pdf`)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
