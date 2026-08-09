import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";
import { tgPersistInboundFile } from "@/lib/telegramTransport";
import { logError } from "@/lib/errorLog";
import { withSystemScope } from "@/lib/tenantScope";
import { secretEquals } from "@/lib/secretCompare";
import { claimInboundBotEvent } from "@/lib/botInboundEvent";

export async function POST(req: NextRequest) {
  const secret = await getSetting("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    await logError("telegram-webhook", "POST received but TELEGRAM_WEBHOOK_SECRET is not set — rejecting").catch(() => {});
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  if (!secretEquals(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

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
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await withSystemScope(async () => {
      if (!(await claimInboundBotEvent("telegram", String(update.update_id ?? "")))) return;

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

      // Telegram sends multiple photo sizes; the last is normally the largest.
      // Documents/video/audio already carry one stable file id.
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
        fileUrl = await tgPersistInboundFile(
          media.file_id,
          media.file_name || fallbackName,
          media.mime_type,
        ) ?? undefined;
      }

      if (text || fileUrl) await runTelegramFlow(chatId, text, undefined, fileUrl);
    });
  } catch (error) {
    await logError("telegram-webhook", error).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
