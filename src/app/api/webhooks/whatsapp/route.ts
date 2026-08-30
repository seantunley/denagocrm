import { NextRequest, NextResponse } from "next/server";
import { whatsappReceipt } from "@/lib/deliveryReceipts";
import { applyReceipt } from "@/lib/messageReceipts";
import crypto from "crypto";
import { getSetting } from "@/lib/settings";
import { recordInboundWhatsApp, fetchWhatsAppMedia } from "@/lib/whatsapp";
import { transcribeVoice } from "@/lib/transcribe";
import { saveFile } from "@/lib/storage";
import { runWhatsAppBot } from "@/lib/flowRun";
import { withChannelTenantScope, validateInSystemScope } from "@/lib/tenantScopeEntry";
import { reportUnmappedEndpoint } from "@/lib/channelRegistration";
import { resolveChannelTenant } from "@/lib/channelTenant";
import { logError } from "@/lib/errorLog";
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
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const verifyToken = await validateInSystemScope(() => getSetting("META_VERIFY_TOKEN"));
  if (params.get("hub.mode") === "subscribe" && secretEquals(token, verifyToken) && challenge) return new NextResponse(challenge, { status: 200 });
  return new NextResponse("Verification failed", { status: 403 });
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const appSecret = await validateInSystemScope(() => getSetting("META_APP_SECRET"));
  if (!appSecret) {
    await logError("whatsapp-webhook", "POST received but META_APP_SECRET is not set — rejecting").catch(() => {});
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  if (!(signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))) {
    await logError("whatsapp-webhook", `Invalid signature — Meta delivered a webhook but META_APP_SECRET doesn't match (header ${signature ? "present" : "MISSING"}).`).catch(() => {});
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const entries = (body as any).entry ?? [];
  // Both retry signals below — a leased event, and a message whose handler threw —
  // leave the batch loop, and neither was caught here, so they escaped the route
  // as unhandled rejections. Aborting the batch is deliberate: a batch carries
  // consecutive messages from one customer, so processing the siblings of a
  // message we could not finish would answer the second question before the
  // first, and the redelivery replays the whole batch in order anyway.
  try {
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const contactsMeta = value.contacts ?? [];
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      await withChannelTenantScope("whatsapp", phoneNumberId, async () => {
        for (const status of value.statuses ?? []) {
          const receipt = whatsappReceipt(status);
          if (receipt) await applyReceipt(receipt);
        }

        for (const message of value.messages ?? []) {
          const outcome = await claimInboundBotEvent("whatsapp", String(message.id ?? ""));
          if (outcome.status === "completed") continue; // genuinely done — ack it.
          if (outcome.status === "unidentified") {
            await logError("whatsapp-webhook", "Inbound message carried no provider id — skipped, because no retry-safe CRM action identity can be derived from it.").catch(() => {});
            continue;
          }
          // Leased: the attempt holding it may have died. Ack would retire Meta's
          // redelivery and lose the message, so ask to be sent it again instead.
          // Logged HERE, inside the tenant scope that owns it. At the outer
          // boundary the scope has unwound and the row files unattributed.
          if (outcome.status === "leased") throw await noteLeasedInbound("whatsapp-webhook", "whatsapp", phoneNumberId, `whatsapp ${String(message.id ?? "")}`);
          const claim = outcome.claim;
          try {
            await withInboundBotEvent(claim, async () => {
              const from: string = message.from;
              const profileName: string | null = contactsMeta.find((c: any) => c.wa_id === from)?.profile?.name ?? null;

              if (message.type === "text") {
                const text = message.text?.body ?? "";
                await recordInboundWhatsApp(from, profileName, text, String(message.id ?? ""));
                await runWhatsAppBot(from, { text });
              } else if (message.type === "interactive") {
                const btn = message.interactive?.button_reply;
                const list = message.interactive?.list_reply;
                const id: string = btn?.id ?? list?.id ?? "";
                const title: string = btn?.title ?? list?.title ?? "";
                if (!id) return;
                await recordInboundWhatsApp(from, profileName, `👆 ${title}`, String(message.id ?? ""));
                await runWhatsAppBot(from, { text: title, choiceId: id });
              } else if (message.type === "image" || message.type === "document" || message.type === "video") {
                const media = message.image ?? message.document ?? message.video;
                const caption: string = media?.caption ?? "";
                let fileUrl: string | undefined;
                if (media?.id) {
                  const dl = await fetchWhatsAppMedia(media.id).catch(() => null);
                  if (dl) {
                    const ext = dl.contentType.includes("pdf") ? "pdf" : dl.contentType.includes("png") ? "png" : dl.contentType.split("/")[1]?.slice(0, 4) || "bin";
                    // The media arrives BEFORE recordInboundWhatsApp has matched or
                    // created a customer record, so there is no parent row to
                    // inherit from yet — and no session either. What there IS is the
                    // business phone number the customer messaged: OUR endpoint,
                    // whose owning workspace ChannelIdentity states outright. That
                    // is the same discriminator withChannelTenantScope resolves
                    // above, asked directly because the scope is not entered while
                    // enforcement is dormant. Null (an unregistered number on a
                    // single-tenant install) stays null — the legacy flat path,
                    // exactly where this file lands today.
                    const channelTenantId = await resolveChannelTenant("whatsapp", phoneNumberId);
                    fileUrl = await saveFile(dl.buffer, `whatsapp.${ext}`, dl.contentType, channelTenantId).catch(() => undefined);
                  }
                }
                await recordInboundWhatsApp(from, profileName, `📎 ${caption || "[file]"}`, String(message.id ?? ""));
                await runWhatsAppBot(from, { text: caption, fileUrl });
              } else if (message.type === "audio" || message.type === "voice") {
                const mediaId: string | undefined = message.audio?.id ?? message.voice?.id;
                if (!mediaId) return;
                const media = await fetchWhatsAppMedia(mediaId).catch(() => null);
                const transcript = media ? await transcribeVoice(media.buffer, media.contentType).catch(() => null) : null;
                const logged = transcript ? `🎤 ${transcript}` : "🎤 [Voice note]";
                await recordInboundWhatsApp(from, profileName, logged, String(message.id ?? ""));
                await runWhatsAppBot(from, { text: transcript ?? "[The customer sent a voice note.]" }, { voiceNote: true });
              }
            });
            await completeInboundBotEvent(claim);
          } catch (error) {
            await retryInboundBotEvent(claim, error).catch(() => {});
            await logError("whatsapp-webhook", error).catch(() => {});
            // Already logged, with its claim released. Rethrowing the raw error
            // made the outer boundary log the same failure a second time.
            throw await noteInboundRetry("whatsapp-webhook", "failed", `whatsapp ${String(message.id ?? "")}`);
          }
        }
      }, () => reportUnmappedEndpoint("whatsapp", phoneNumberId, value?.messages?.length ?? 0));
    }
  }
  } catch (error) {
    return inboundRetryResponse("whatsapp-webhook", error);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return NextResponse.json({ received: true });
}
