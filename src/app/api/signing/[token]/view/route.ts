import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { isRequestClosed } from "@/lib/signing/status";
import { mergeViewReport, MAX_VIEWS_PER_RECIPIENT } from "@/lib/signing/viewAnalytics";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { SIGNING_READ_POLICY } from "@/lib/rateLimit";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The signing page reporting that it is open: "open" starts a sitting,
 * "heartbeat" and "close" update how long it has been in view and how far the
 * reader got.
 *
 * Public, addressed by the signing link, so everything it is told is treated as
 * a claim: the figures are bounded and only ever go up (mergeViewReport), a
 * sitting can only be updated through the link that opened it, and the number
 * of sittings per recipient is capped. It stores no IP address and no browser
 * string — this is an indication for staff, not evidence.
 */
type Body = { event?: unknown; viewId?: unknown; page?: unknown; seconds?: unknown };

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return Response.json({ ok: false }, { status: 400 });
  const throttled = await throttlePublic("signing-view", token, SIGNING_READ_POLICY);
  if (throttled) return throttled;
  const body = (await req.json().catch(() => ({}))) as Body;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handle(token, body ?? {}),
    () => Response.json({ ok: false }, { status: 404 }),
  );
}

async function handle(token: string, body: Body): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: { id: true, tokenRevokedAt: true, request: { select: { id: true, tenantId: true, status: true, deletedAt: true, expiresAt: true } } },
  });
  if (!recipient) return Response.json({ ok: false }, { status: 404 });
  const request = recipient.request;
  if (recipient.tokenRevokedAt || request.deletedAt || isRequestClosed(request.status) || (request.expiresAt && request.expiresAt < new Date())) {
    return Response.json({ ok: false }, { status: 409 });
  }

  if (body.event === "open") {
    // Reloading the page over and over must not write without limit. Past the cap the page is told
    // "fine" and simply has no sitting to report on — signing is never affected.
    const sittings = await prisma.signatureView.count({ where: { recipientId: recipient.id } });
    if (sittings >= MAX_VIEWS_PER_RECIPIENT) return Response.json({ ok: true });
    const view = await prisma.signatureView.create({
      // The sitting belongs to the workspace that owns the REQUEST it is a sitting with.
      data: { tenantId: request.tenantId ?? ownedWriteTenantId(), requestId: request.id, recipientId: recipient.id },
      select: { id: true },
    });
    return Response.json({ ok: true, viewId: view.id });
  }

  if ((body.event === "heartbeat" || body.event === "close") && typeof body.viewId === "string" && body.viewId.length <= 64) {
    // Only a sitting opened through THIS link: the id alone is not enough.
    const view = await prisma.signatureView.findFirst({
      where: { id: body.viewId, recipientId: recipient.id, requestId: request.id },
      select: { id: true, seconds: true, maxPage: true },
    });
    if (!view) return Response.json({ ok: false }, { status: 404 });
    await prisma.signatureView.updateMany({
      where: { id: view.id, recipientId: recipient.id, requestId: request.id },
      data: { lastSeenAt: new Date(), ...mergeViewReport(view, body) },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 400 });
}
