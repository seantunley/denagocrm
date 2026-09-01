import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { basePrisma, prisma } from "@/lib/db";
import { getSetting, resolveTenantCredential } from "@/lib/settings";
import { currentTenantScope } from "@/lib/tenantScope";
import { DEFAULT_TENANT_ID } from "@/lib/tenant";
import { createIntakeLead } from "@/lib/leadIntake";
import { parseLeadFields, metaSource } from "@/lib/metaLead";
import { recordInboundDm, recordDmEcho, type DmPlatform } from "@/lib/messenger";
import { runDmFlow } from "@/lib/flowDm";
import { metaReceipt } from "@/lib/deliveryReceipts";
import { applyReceipt } from "@/lib/messageReceipts";
import { withChannelTenantScope, validateInSystemScope } from "@/lib/tenantScopeEntry";
import { reportUnmappedEndpoint } from "@/lib/channelRegistration";
import { decideComment, type FeedChangeValue } from "@/lib/socialComments";
import { recordPostCommentSafely } from "@/lib/commentThreads";
import { inboundRetryResponse, noteInboundRetry, noteLeasedInbound } from "@/lib/webhookRetry";
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
    { cache: "no-store", signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function latestPersistedDmAttachment(platform: DmPlatform, senderId: string, receivedAfter: Date): Promise<string | undefined> {
  const idField = platform === "instagram" ? "instagramId" : "messengerPsid";
  const contact = await prisma.contact.findFirst({ where: { [idField]: senderId }, select: { id: true } });
  if (!contact) return undefined;
  const saved = await prisma.communication.findFirst({
    where: { type: platform, direction: "inbound", contactId: contact.id, attachmentUrl: { not: null }, occurredAt: { gte: receivedAfter } },
    orderBy: { occurredAt: "desc" },
    select: { attachmentUrl: true },
  });
  return saved?.attachmentUrl ?? undefined;
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const appSecret = await validateInSystemScope(() => getSetting("META_APP_SECRET"));
  if (!appSecret) return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  if (!(signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const objectType = (body as any).object as string | undefined;
  if (objectType === "page" || objectType === "instagram") {
    const platform: DmPlatform = objectType === "instagram" ? "instagram" : "messenger";
    // Both retry signals below — a leased event, and a message whose handler threw
    // — leave the batch loop, and neither was caught here, so they escaped the
    // route as unhandled rejections. Aborting the batch is deliberate: a batch
    // carries consecutive messages from one customer, so processing the siblings
    // of a message we could not finish would answer the second question before the
    // first, and the redelivery replays the whole batch in order anyway.
    try {
    for (const entry of (body as any).entry ?? []) {
      const endpointId = String(entry.id ?? "");
      await withChannelTenantScope(platform, endpointId, async () => {
        for (const ev of entry.messaging ?? []) {
          const referral = ev.message?.referral ?? ev.referral ?? ev.postback?.referral ?? null;
          const payload: string | undefined = ev.message?.quick_reply?.payload ?? ev.postback?.payload;
          const text: string = ev.message?.text ?? ev.postback?.title ?? (referral ? "start" : "");
          const attachments = ((ev.message?.attachments ?? []) as any[])
            .map((a) => ({ type: String(a.type ?? "file"), url: String(a.payload?.url ?? "") }))
            .filter((a) => a.url);
          if (ev.delivery || ev.read) {
            const receipt = metaReceipt(ev, platform);
            if (receipt) await applyReceipt(receipt);
            continue;
          }
          if (ev.message?.is_echo) {
            if (text) await recordDmEcho(platform, String(ev.recipient?.id ?? ""), text, ev.message?.mid ? String(ev.message.mid) : null);
            continue;
          }
          if (!ev.message && !ev.postback && !referral) continue;
          if (!text && !payload && attachments.length === 0) continue;

          const senderId = String(ev.sender?.id ?? "");
          // Never synthesize an id from sender/time: retries can be delivered with a
          // different timestamp and would duplicate CRM side effects.
          const providerId = String(ev.message?.mid ?? ev.postback?.mid ?? "");
          const outcome = await claimInboundBotEvent(platform, providerId);
          if (outcome.status === "completed") continue; // genuinely done — ack it.
          if (outcome.status === "unidentified") {
            const { logError } = await import("@/lib/errorLog");
            await logError("meta-dm-webhook", "Inbound message carried no provider mid — skipped, because no retry-safe CRM action identity can be derived from it.").catch(() => {});
            continue;
          }
          // Leased: the attempt holding it may have died. Ack would retire Meta's
          // redelivery and lose the message, so ask to be sent it again instead.
          // Logged HERE, inside the tenant scope that owns it. At the outer
          // boundary the scope has unwound and the row files unattributed.
          if (outcome.status === "leased") throw await noteLeasedInbound("meta-dm-webhook", platform, endpointId, `${platform} ${providerId}`);
          const claim = outcome.claim;
          try {
            await withInboundBotEvent(claim, async () => {
              const receivedAfter = new Date(Date.now() - 1000);
              await recordInboundDm(platform, senderId, text, referral, attachments, providerId);
              const fileUrl = attachments.length ? await latestPersistedDmAttachment(platform, senderId, receivedAfter) : undefined;
              const entryContext = referral ? {
                referralRef: referral.ref ? String(referral.ref) : undefined,
                adId: referral.ad_id ? String(referral.ad_id) : undefined,
                source: referral.source ? String(referral.source) : undefined,
              } : undefined;
              if (text || payload || fileUrl) await runDmFlow(platform, senderId, text, payload, fileUrl, entryContext);
            });
            await completeInboundBotEvent(claim);
          } catch (error) {
            await retryInboundBotEvent(claim, error).catch(() => {});
            const { logError } = await import("@/lib/errorLog");
            await logError("meta-dm-webhook", error).catch(() => {});
            // Already logged, with its claim released. Rethrowing the raw error
            // made the outer boundary log the same failure a second time.
            throw await noteInboundRetry("meta-dm-webhook", "failed", `${platform} ${providerId}`);
          }
        }
      }, () => reportUnmappedEndpoint(platform, endpointId, (entry.messaging ?? []).length));
    }
    } catch (error) {
      return inboundRetryResponse("meta-dm-webhook", error);
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const entries = (body as { entry?: { id?: string; changes?: { field: string; value: Record<string, unknown> }[] }[] }).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      /*
       * COMMENTS ON POSTS — AND ON ADS.
       *
       * Meta's documentation: "Webhooks are not sent for Ad Posts, but are sent
       * for Comments on Ad Posts." So a comment on a boosted post, or on a dark
       * post created straight in Ads Manager, arrives here in exactly the same
       * shape as one on an organic post. No special handling, and none needed.
       *
       * `feed` is a firehose — likes, reactions, shares, edits and deletions all
       * come down it — so `decideComment` filters first. Without that the inbox
       * fills with reaction noise on the first busy campaign, and people stop
       * opening the inbox that currently works.
       *
       * The Page id is `entry.id`, which is both the tenant discriminator and
       * the way to tell OUR reply apart from a customer's comment.
       */
      if (change.field === "feed") {
        const pageId = String(entry.id ?? "");
        const decision = decideComment(change.value as FeedChangeValue);
        if (!decision.ok) continue;
        await withChannelTenantScope(
          "messenger",
          pageId,
          async () => {
            await recordPostCommentSafely(decision.comment, { platform: "facebook", pageId });
          },
          // Now that #578 has landed, a dropped comment goes to the System Log
          // like every other unattributable inbound event — which is the point
          // of that change: an endpoint nobody claims must be readable, not a
          // console line on Vercel that nobody sees.
          () => reportUnmappedEndpoint("messenger", pageId, 1),
        );
        continue;
      }
      if (change.field !== "leadgen") continue;
      const leadgenId = String(change.value?.leadgen_id ?? "");
      if (!leadgenId) continue;
      const pageId = String(change.value?.page_id ?? "");
      await withChannelTenantScope("messenger", pageId, async () => {
        // Scoped to the tenant that owns this Page: a leadgen id is unique to Meta,
        // not to us, so two tenants may legitimately receive the same one.
        const existing = await basePrisma.lead.findFirst({ where: { externalId: leadgenId, tenantId: currentTenantScope()?.tenantId ?? DEFAULT_TENANT_ID }, select: { id: true } });
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
      }, () => reportUnmappedEndpoint("messenger", pageId, 1));
    }
  }
  return NextResponse.json({ received: true });
}
