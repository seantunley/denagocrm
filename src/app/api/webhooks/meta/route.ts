import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { basePrisma } from "@/lib/db";
import { getSetting, resolveTenantCredential } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";
import { createIntakeLead } from "@/lib/leadIntake";
import { parseLeadFields, metaSource } from "@/lib/metaLead";
import { recordInboundDm, recordDmEcho, type DmPlatform } from "@/lib/messenger";
import { runDmFlow } from "@/lib/flowDm";
import { metaReceipt } from "@/lib/deliveryReceipts";
import { applyReceipt } from "@/lib/messageReceipts";
import { withChannelTenantScope, validateInSystemScope } from "@/lib/tenantScopeEntry";
import { secretEquals } from "@/lib/secretCompare";
import {
  claimInboundBotEvent,
  completeInboundBotEvent,
  retryInboundBotEvent,
  withInboundBotEvent,
} from "@/lib/botInboundEvent";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const verifyToken = await validateInSystemScope(() => getSetting("META_VERIFY_TOKEN"));
  if (mode === "subscribe" && secretEquals(token, verifyToken) && challenge) return new NextResponse(challenge, { status: 200 });
  return new NextResponse("Verification failed", { status: 403 });
}

async function fetchLeadDetails(leadgenId: string, accessToken: string) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,created_time,ad_name,form_id,platform&access_token=${encodeURIComponent(accessToken)}`,
    { cache: "no-store", signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const appSecret = await validateInSystemScope(() => getSetting("META_APP_SECRET"));
  if (!appSecret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
    const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const objectType = (body as any).object as string | undefined;
  if (objectType === "page" || objectType === "instagram") {
    const platform: DmPlatform = objectType === "instagram" ? "instagram" : "messenger";
    for (const entry of (body as any).entry ?? []) {
      const endpointId = String(entry.id ?? "");
      await withChannelTenantScope(platform, endpointId, async () => {
        for (const ev of entry.messaging ?? []) {
          const text: string = ev.message?.text ?? "";
          const attachments = ((ev.message?.attachments ?? []) as any[])
            .map((a) => ({ type: String(a.type ?? "file"), url: String(a.payload?.url ?? "") }))
            .filter((a) => a.url);

          if (ev.delivery || ev.read) {
            const receipt = metaReceipt(ev, platform);
            if (receipt) await applyReceipt(receipt);
            continue;
          }
          if (ev.message?.is_echo) {
            if (text) await recordDmEcho(platform, String(ev.recipient?.id ?? ""), text);
            continue;
          }
          if (!ev.message || (!text && attachments.length === 0)) continue;

          const claim = await claimInboundBotEvent(platform, String(ev.message?.mid ?? ""));
          if (!claim) continue;
          try {
            await withInboundBotEvent(claim, async () => {
              const referral = ev.message.referral ?? ev.referral ?? ev.postback?.referral ?? null;
              const senderId = String(ev.sender?.id ?? "");
              await recordInboundDm(platform, senderId, text, referral, attachments);
              const payload: string | undefined = ev.message.quick_reply?.payload;
              if (text || payload) await runDmFlow(platform, senderId, text, payload);
            });
            await completeInboundBotEvent(claim);
          } catch (error) {
            await retryInboundBotEvent(claim, error).catch(() => {});
            const { logError } = await import("@/lib/errorLog");
            await logError("meta-dm-webhook", error).catch(() => {});
            throw error;
          }
        }
      }, () => {
        console.warn(`[tenant-channel] skipped ${platform} DM: unmapped endpoint ${endpointId || "?"}`);
      });
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const entries = (body as { entry?: { changes?: { field: string; value: Record<string, unknown> }[] }[] }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const leadgenId = String(change.value?.leadgen_id ?? "");
      if (!leadgenId) continue;
      const pageId = String(change.value?.page_id ?? "");

      await withChannelTenantScope("messenger", pageId, async () => {
        const existing = await basePrisma.lead.findUnique({ where: { externalId: leadgenId }, select: { id: true } });
        if (existing) return;
        const accessToken = await resolveTenantCredential(currentTenantScope()?.tenantId ?? null, "META_PAGE_ACCESS_TOKEN");
        try {
          if (!accessToken) throw new Error("META_PAGE_ACCESS_TOKEN not configured");
          const details = await fetchLeadDetails(leadgenId, accessToken);
          const parsed = parseLeadFields(details.field_data ?? []);
          await createIntakeLead({
            name: parsed.name ?? "New lead", email: parsed.email, phone: parsed.phone,
            model: parsed.model, color: parsed.color, message: parsed.message,
            source: metaSource(details.platform), externalId: leadgenId, raw: details,
          });
        } catch (err) {
          await createIntakeLead({
            name: "Facebook lead (details pending)",
            message: `Could not fetch lead ${leadgenId} from Graph API: ${err instanceof Error ? err.message : "unknown error"}. Check the Page Access Token in Settings.`,
            source: "facebook", externalId: leadgenId, raw: change.value,
          }).catch(() => {});
        }
      }, () => console.warn(`[tenant-channel] skipped leadgen: unmapped page_id ${pageId || "?"}`));
    }
  }
  return NextResponse.json({ received: true });
}
