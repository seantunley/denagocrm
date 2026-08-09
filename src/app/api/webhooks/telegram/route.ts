import { NextRequest, NextResponse } from "next/server";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";
import { tgPersistInboundFile } from "@/lib/telegramTransport";
import { logError } from "@/lib/errorLog";
import { claimInboundBotEvent } from "@/lib/botInboundEvent";
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
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    return await withTelegramTenantScope(
      webhookSecret,
      async () => {
        if (!(await claimInboundBotEvent("telegram", String(update.update_id ?? "")))) {
          return NextResponse.json({ ok: true });
        }

        if (update.callback_query) {
          const cq = update.callback_query;
          await tgAnswerCallback(cq.id);
          const chatId = cq.message?.chat?.id;
          if (chatId != null && cq.data) await runTelegramFlow(chatId, "", cq.data);
          return NextResponse.json({ ok: true });
        }

        const message = update.message;
        const chatId = message?.chat?.id;
        if (chatId == null || !message) return NextResponse.json({ ok: true });
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
        return NextResponse.json({ ok: true });
      },
      async () => {
        await logError("telegram-webhook", "Rejected Telegram update: webhook secret did not resolve to an active tenant").catch(() => {});
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      },
    );
  } catch (error) {
    await logError("telegram-webhook", error).catch(() => {});
    return NextResponse.json({ ok: true });
  }
}
