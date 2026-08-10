import { NextRequest, NextResponse } from "next/server";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";
import { tgPersistInboundFile } from "@/lib/telegramTransport";
import { logError } from "@/lib/errorLog";
import { inboundRetryResponse, noteInboundRetry } from "@/lib/webhookRetry";
import {
  claimInboundBotEvent,
  completeInboundBotEvent,
  retryInboundBotEvent,
  withInboundBotEvent,
} from "@/lib/botInboundEvent";
import { withTelegramTenantScope } from "@/lib/telegramTenant";

export async function POST(req: NextRequest) {
  const webhookSecret = req.headers.get("x-telegram-bot-api-secret-token");

  type TgFile = { file_id?: string; file_name?: string; mime_type?: string; file_size?: number };
  let update: {
    update_id?: number;
    message?: {
      text?: string;
      caption?: string;
      chat?: { id?: number };
      document?: TgFile;
      video?: TgFile;
      audio?: TgFile;
      photo?: TgFile[];
    };
    callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
  };
  try { update = await req.json(); } catch { return NextResponse.json({ ok: true }); }

  // The leased signal below is thrown outside the inner try, so without this it
  // leaves the route as an unhandled rejection: no ErrorLog row, a crashed
  // invocation in the platform's eyes, and an unexplained 500 in the run of
  // statuses Telegram sees. Answer it deliberately instead.
  try {
    return await withTelegramTenantScope(
    webhookSecret,
    async () => {
      const outcome = await claimInboundBotEvent("telegram", String(update.update_id ?? ""));
      if (outcome.status === "completed") return NextResponse.json({ ok: true }); // genuinely done — ack it.
      if (outcome.status === "unidentified") {
        await logError("telegram-webhook", "Inbound update carried no update_id — skipped, because no retry-safe CRM action identity can be derived from it.").catch(() => {});
        return NextResponse.json({ ok: true });
      }
      // Leased: the attempt holding it may have died. Ack would retire Telegram's
      // redelivery and lose the update, so ask to be sent it again instead.
      // Logged HERE, inside the tenant scope that owns it. At the outer boundary
      // the scope has unwound and the row files unattributed.
      if (outcome.status === "leased") throw await noteInboundRetry("telegram-webhook", "leased", `telegram ${String(update.update_id ?? "")}`);
      const claim = outcome.claim;
      try {
        await withInboundBotEvent(claim, async () => {
          if (update.callback_query) {
            const cq = update.callback_query;
            await tgAnswerCallback(cq.id);
            const chatId = cq.message?.chat?.id;
            if (chatId != null && cq.data) await runTelegramFlow(chatId, "", cq.data);
            return;
          }

          const message = update.message;
          const chatId = message?.chat?.id;
          if (chatId == null || !message) return;
          const text = message.text ?? message.caption ?? "";
          const media = message.document ?? message.video ?? message.audio ?? message.photo?.at(-1);
          let fileUrl: string | undefined;
          if (media?.file_id) {
            const fallbackName = message.document
              ? "telegram-document.bin"
              : message.video
              ? "telegram-video.mp4"
              : message.audio
              ? "telegram-audio.bin"
              : "telegram-photo.jpg";
            fileUrl = await tgPersistInboundFile(media.file_id, media.file_name || fallbackName, media.mime_type) ?? undefined;
          }
          if (text || fileUrl) await runTelegramFlow(chatId, text, undefined, fileUrl);
        });
        await completeInboundBotEvent(claim);
        return NextResponse.json({ ok: true });
      } catch (error) {
        await retryInboundBotEvent(claim, error).catch(() => {});
        await logError("telegram-webhook", error).catch(() => {});
        // Non-2xx asks Telegram to redeliver the now-released leased event.
        return NextResponse.json({ error: "retry" }, { status: 500 });
      }
    },
    async () => {
      await logError("telegram-webhook", "Rejected Telegram update: webhook secret did not resolve to an active tenant").catch(() => {});
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    },
    );
  } catch (error) {
    return inboundRetryResponse("telegram-webhook", error);
  }
}
