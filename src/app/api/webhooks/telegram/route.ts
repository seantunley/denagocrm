import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";

export async function POST(req: NextRequest) {
  // Telegram echoes back the secret we set on the webhook.
  const secret = await getSetting("TELEGRAM_WEBHOOK_SECRET");
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let update: {
    message?: { text?: string; chat?: { id?: number } };
    callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
  };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      await tgAnswerCallback(cq.id);
      const chatId = cq.message?.chat?.id;
      if (chatId != null && cq.data) await runTelegramFlow(chatId, "", cq.data);
    } else if (update.message?.text) {
      const chatId = update.message.chat?.id;
      if (chatId != null) await runTelegramFlow(chatId, update.message.text);
    }
  } catch {
    // never fail the webhook
  }
  return NextResponse.json({ ok: true });
}
