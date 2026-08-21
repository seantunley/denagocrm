import { NextResponse } from "next/server";
import { resolveChannelTenant } from "@/lib/channelTenant";
import { resolveTenantCredential } from "@/lib/settings";
import { withChannelTenantScope } from "@/lib/tenantScopeEntry";
import { normaliseXActivity, verifyXSignature, xCrcResponse } from "@/lib/xWebhook";
import { recordInboundDm } from "@/lib/messenger";

// X publishes several documented envelope generations; the normaliser validates the\n// fields it consumes after the raw request signature has been verified.\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nfunction accountIdFrom(body: Record<string, any>, request: Request): string {
  return String(
    body.for_user_id ?? body.account_id ?? body.user_id ??
    body.data?.filter?.user_id ??
    new URL(request.url).searchParams.get("account_id") ?? "",
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("crc_token");
  const accountId = url.searchParams.get("account_id");
  if (!token || !accountId) return NextResponse.json({ error: "Missing CRC token or account." }, { status: 400 });
  const owner = await resolveChannelTenant("x", accountId);
  if (!owner) return NextResponse.json({ error: "Unknown X account." }, { status: 404 });
  const secret = await resolveTenantCredential(owner, "X_WEBHOOK_SECRET");
  if (!secret) return NextResponse.json({ error: "X webhook not configured." }, { status: 503 });
  return NextResponse.json({ response_token: xCrcResponse(secret, token) });
}

export async function POST(request: Request) {
  const raw = await request.text();
  // JSON.parse is untyped at this boundary; field validation happens in the\n  // discriminator and normaliser before anything is persisted.\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const accountId = accountIdFrom(body, request);
  if (!accountId) return NextResponse.json({ error: "Missing X account discriminator." }, { status: 400 });
  const owner = await resolveChannelTenant("x", accountId);
  if (!owner) return NextResponse.json({ error: "Unknown or inactive X account." }, { status: 404 });
  const secret = await resolveTenantCredential(owner, "X_WEBHOOK_SECRET");
  const signature = request.headers.get("x-twitter-webhooks-signature") ?? request.headers.get("x-webhooks-signature");
  if (!secret || !verifyXSignature(secret, raw, signature)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const events = normaliseXActivity(body, accountId);
  await withChannelTenantScope("x", accountId, async () => {
    for (const event of events) {
      // A truthy referral makes the existing inbox ingestion create (or reuse)
      // the contact's open lead. The provider id becomes the transcript dedupe key.
      await recordInboundDm("x", event.senderId, event.text, { source: event.kind }, [], event.id);
    }
  }, () => undefined);
  return NextResponse.json({ received: true, events: events.length });
}
