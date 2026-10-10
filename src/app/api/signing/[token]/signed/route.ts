import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { openFileStream } from "@/lib/storage";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { isRequestClosed } from "@/lib/signing/status";
import { SIGNED_COPY_COOKIE, verifySignedCopyPass } from "@/lib/signing/signedCopyPass";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenantForNotice } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { SIGNING_READ_POLICY } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signed copy, for the browser that just signed — and for no one else.
 *
 * By the time a signed copy exists its link has been revoked, so this is the one
 * route that answers a revoked link with a document. What authorises it is NOT
 * the link: it is the pass the sign route set in this browser a moment ago
 * (signedCopyPass.ts), checked against the signer and workspace on the row. A
 * link out of an inbox, a history or a forwarded message has no pass and gets
 * the same 403 whether or not the document exists.
 *
 *   ?check   answers whether the copy is ready, so the page can offer the
 *            button only once it will work: "ready", "preparing" (everyone has
 *            signed; it is being sealed), "waiting" (others still to sign) or
 *            "unavailable" (the request was closed without completing).
 *   (none)   the sealed PDF itself.
 *
 * Read-only: nothing is written, sent or changed.
 */
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return new Response("Invalid link", { status: 400 });
  const throttled = await throttlePublic("signing-read", token, SIGNING_READ_POLICY);
  if (throttled) return throttled;
  const check = new URL(req.url).searchParams.has("check");
  return withTokenTenantScope(
    () => resolveSignRecipientTenantForNotice(token),
    () => signedCopy(token, check),
    () => new Response("Not found", { status: 404 }),
  );
}

async function signedCopy(token: string, check: boolean): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    include: { request: { include: { recipients: { select: { role: true, status: true } } } } },
  });
  // The pass first, and the same answer for every way of not having one: a
  // caller without it learns nothing about the document, not even that it exists.
  const pass = (await cookies()).get(SIGNED_COPY_COOKIE)?.value;
  if (!recipient || !recipient.tenantId || !verifySignedCopyPass(pass, recipient.id, recipient.tenantId)) {
    return new Response("Not available", { status: 403 });
  }
  const request = recipient.request;
  if (request.deletedAt || recipient.status !== "signed") return new Response("Not available", { status: 403 });

  const ready = request.status === "completed" && Boolean(request.signedPdfRef);
  if (check) {
    const everyoneSigned = request.recipients.filter((r) => r.role !== "viewer").every((r) => r.status === "signed");
    // Withdrawn or rejected after this signature: there will never be a copy, so
    // the page must stop asking rather than promise one.
    const state = ready ? "ready" : isRequestClosed(request.status) ? "unavailable" : everyoneSigned ? "preparing" : "waiting";
    return Response.json({ state }, { headers: { "Cache-Control": "no-store" } });
  }
  if (!ready) return new Response("Your signed copy is not ready yet.", { status: 409 });

  let stream: ReadableStream<Uint8Array>;
  try {
    stream = await openFileStream(request.signedPdfRef!, request.tenantId);
  } catch {
    return new Response("Your signed copy could not be prepared. Please ask the sender for it.", { status: 503 });
  }
  return new Response(stream, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${request.title} (signed).pdf`)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
