import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getSetting } from "@/lib/settings";
import { recordInboundWhatsApp, fetchWhatsAppMedia } from "@/lib/whatsapp";
import { transcribeVoice } from "@/lib/transcribe";
import { saveFile } from "@/lib/storage";
import { runWhatsAppBot } from "@/lib/flowRun";
import { withChannelTenantScope } from "@/lib/tenantScopeEntry";
import { logError } from "@/lib/errorLog";

/** Meta webhook verification handshake (same flow as Lead Ads). */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  const verifyToken = await getSetting("META_VERIFY_TOKEN");
  if (params.get("hub.mode") === "subscribe" && token === verifyToken && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }
  return new NextResponse("Verification failed", { status: 403 });
}

/** Receives WhatsApp Cloud API events (inbound customer messages). */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // Fail CLOSED: without the app secret we cannot verify the sender, so an
  // unauthenticated POST must not be able to drive the auto-reply bot.
  const appSecret = await getSetting("META_APP_SECRET");
  if (!appSecret) {
    await logError("whatsapp-webhook", "POST received but META_APP_SECRET is not set — rejecting").catch(() => {});
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  {
    const signature = req.headers.get("x-hub-signature-256") ?? "";
    const expected =
      "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
    const valid =
      signature.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      // Meta IS reaching us but the signature doesn't match — almost always a
      // wrong/other-app META_APP_SECRET. Log so it's diagnosable in System Log.
      await logError(
        "whatsapp-webhook",
        `Invalid signature — Meta delivered a webhook but META_APP_SECRET doesn't match (header ${
          signature ? "present" : "MISSING"
        }).`
      ).catch(() => {});
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const entries = (body as any).entry ?? [];
  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const contactsMeta = value.contacts ?? [];
      // Per-change tenant chokepoint: resolve WHICH tenant owns this WhatsApp
      // business number, then process the change's messages inside that scope.
      // Dormant → runs directly, unchanged. Unknown/disabled endpoint under
      // enforcement → the messages are skipped (fail closed), never run unscoped.
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      await withChannelTenantScope("whatsapp", phoneNumberId, async () => {
      for (const message of value.messages ?? []) {
        const from: string = message.from;
        const profileName: string | null =
          contactsMeta.find((c: any) => c.wa_id === from)?.profile?.name ?? null;

        if (message.type === "text") {
          const body = message.text?.body ?? "";
          await recordInboundWhatsApp(from, profileName, body).catch(() => {});
          await runWhatsAppBot(from, { text: body }).catch(() => {});
        } else if (message.type === "interactive") {
          // A tapped button or list option.
          const btn = message.interactive?.button_reply;
          const list = message.interactive?.list_reply;
          const id: string = btn?.id ?? list?.id ?? "";
          const title: string = btn?.title ?? list?.title ?? "";
          if (!id) continue;
          await recordInboundWhatsApp(from, profileName, `👆 ${title}`).catch(() => {});
          await runWhatsAppBot(from, { text: title, choiceId: id }).catch(() => {});
        } else if (message.type === "image" || message.type === "document" || message.type === "video") {
          // Inbound photo/file — save it and pass to the flow (capture-file node)
          const media = message.image ?? message.document ?? message.video;
          const caption: string = media?.caption ?? "";
          let fileUrl: string | undefined;
          if (media?.id) {
            const dl = await fetchWhatsAppMedia(media.id).catch(() => null);
            if (dl) {
              const ext = dl.contentType.includes("pdf") ? "pdf" : dl.contentType.includes("png") ? "png" : dl.contentType.split("/")[1]?.slice(0, 4) || "bin";
              fileUrl = await saveFile(dl.buffer, `whatsapp.${ext}`, dl.contentType).catch(() => undefined);
            }
          }
          await recordInboundWhatsApp(from, profileName, `📎 ${caption || "[file]"}`).catch(() => {});
          await runWhatsAppBot(from, { text: caption, fileUrl }).catch(() => {});
        } else if (message.type === "audio" || message.type === "voice") {
          // Voice note: download, transcribe, reply naturally, then hand off.
          const mediaId: string | undefined = message.audio?.id ?? message.voice?.id;
          if (!mediaId) continue;
          const media = await fetchWhatsAppMedia(mediaId).catch(() => null);
          const transcript = media
            ? await transcribeVoice(media.buffer, media.contentType).catch(() => null)
            : null;
          const logged = transcript ? `🎤 ${transcript}` : "🎤 [Voice note]";
          await recordInboundWhatsApp(from, profileName, logged).catch(() => {});
          await runWhatsAppBot(from, { text: transcript ?? "[The customer sent a voice note.]" }, {
            voiceNote: true,
          }).catch(() => {});
        }
      }
      }, () => {
        console.warn(`[tenant-channel] skipped WhatsApp inbound: unmapped phone_number_id ${phoneNumberId ?? "?"}`);
      });
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return NextResponse.json({ received: true });
}
