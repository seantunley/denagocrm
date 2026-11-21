import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { resolveChannelTenant } from "@/lib/channelTenant";
import { resolveIntegrationBundle } from "@/lib/settings";
import { validateInSystemScope, withChannelTenantScope } from "@/lib/tenantScopeEntry";
import { secretEquals } from "@/lib/secretCompare";
import { threadsRepliesFrom } from "@/lib/threadsWebhook";
import { recordPostCommentSafely } from "@/lib/commentThreads";
import { reportUnmappedEndpoint } from "@/lib/channelRegistration";

/**
 * THREADS WEBHOOK (Sean, 2026-11-21). Each workspace's own Threads app delivers here with `?workspace=<slug>`:
 * verified with ITS verify token, signed with ITS app secret, and the payload must name ITS app id. A reply is filed
 * only for a Threads account connected to THAT workspace — never another's, never unscoped.
 */
async function workspaceApp(slug: string | null) {
  const clean = (slug ?? "").trim().toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(clean)) return null;
  return validateInSystemScope(async () => {
    const tenant = await basePrisma.tenant.findUnique({ where: { slug: clean }, select: { id: true, active: true } });
    if (!tenant?.active) return null;
    const app = await resolveIntegrationBundle(tenant.id, "threads");
    return { tenantId: tenant.id, appId: app?.THREADS_APP_ID ?? null, secret: app?.THREADS_APP_SECRET ?? null, verifyToken: app?.THREADS_VERIFY_TOKEN ?? null };
  });
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const app = await workspaceApp(params.get("workspace"));
  const challenge = params.get("hub.challenge");
  if (app?.verifyToken && params.get("hub.mode") === "subscribe" && secretEquals(params.get("hub.verify_token"), app.verifyToken) && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const app = await workspaceApp(req.nextUrl.searchParams.get("workspace"));
  if (!app) return NextResponse.json({ error: "Unknown workspace" }, { status: 404 });
  if (!app.secret || !app.appId) return NextResponse.json({ error: "Threads isn't set up for this workspace" }, { status: 503 });
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", app.secret).update(raw, "utf8").digest("hex");
  if (!(signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  for (const reply of threadsRepliesFrom(body, app.appId)) {
    // This workspace's own Threads account only.
    if ((await resolveChannelTenant("threads", reply.accountId)) !== app.tenantId) {
      await reportUnmappedEndpoint("threads", reply.accountId, 1);
      continue;
    }
    await withChannelTenantScope(
      "threads",
      reply.accountId,
      async () => { await recordPostCommentSafely(reply.comment, { platform: "threads", pageId: reply.accountId }); },
      () => reportUnmappedEndpoint("threads", reply.accountId, 1),
    );
  }
  return NextResponse.json({ received: true });
}
