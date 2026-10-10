import { prisma } from "@/lib/db";
import { isValidSignToken, hashSignToken } from "@/lib/signing/tokens";
import { reqMeta } from "@/lib/signing/events";
import { isRequestClosed } from "@/lib/signing/status";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveSignRecipientTenant } from "@/lib/tokenTenant";
import { throttlePublic } from "@/lib/publicThrottle";
import { SIGNING_READ_POLICY } from "@/lib/rateLimit";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SECONDS = 30 * 60;

type Body = { event?: string; viewId?: string; page?: number; seconds?: number; sections?: string[] };

export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!isValidSignToken(token)) return Response.json({ ok: false }, { status: 400 });
  const throttled = await throttlePublic("signing-view", token, SIGNING_READ_POLICY);
  if (throttled) return throttled;
  const body = (await req.json().catch(() => ({}))) as Body;
  return withTokenTenantScope(
    () => resolveSignRecipientTenant(token),
    () => handle(token, body),
    () => Response.json({ ok: false }, { status: 404 }),
  );
}

async function handle(token: string, body: Body): Promise<Response> {
  const recipient = await prisma.signatureRecipient.findUnique({
    where: { token: hashSignToken(token) },
    select: { id: true, request: { select: { id: true, status: true, deletedAt: true, expiresAt: true } } },
  });
  if (!recipient) return Response.json({ ok: false }, { status: 404 });
  const request = recipient.request;
  if (request.deletedAt || isRequestClosed(request.status) || (request.expiresAt && request.expiresAt < new Date())) {
    return Response.json({ ok: false }, { status: 409 });
  }

  if (body.event === "open") {
    const meta = await reqMeta();
    const view = await prisma.signatureView.create({
      data: {
        tenantId: ownedWriteTenantId(),
        requestId: request.id,
        recipientId: recipient.id,
        channel: "web",
        ip: meta.ip,
        userAgent: meta.ua,
      },
      select: { id: true },
    });
    return Response.json({ ok: true, viewId: view.id });
  }

  if ((body.event === "heartbeat" || body.event === "close") && body.viewId) {
    const seconds = Math.min(MAX_SECONDS, Math.max(0, Math.round(body.seconds ?? 0)));
    const maxPage = Math.max(1, Math.min(50, Math.round(body.page ?? 1)));
    const sections = Array.isArray(body.sections) ? body.sections.filter((s) => typeof s === "string").slice(0, 12) : [];
    await prisma.signatureView.updateMany({
      where: { id: body.viewId, recipientId: recipient.id, requestId: request.id },
      data: { lastSeenAt: new Date(), seconds, maxPage, sections },
    });
    return Response.json({ ok: true });
  }

  return Response.json({ ok: false }, { status: 400 });
}
