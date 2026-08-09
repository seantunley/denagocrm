import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";
import { logError } from "@/lib/errorLog";
import { withSystemScope } from "@/lib/tenantScope";
import { secretEquals } from "@/lib/secretCompare";
import { claimInboundBotEvent } from "@/lib/botInboundEvent";

export async function POST(req: NextRequest) {
  // Telegram echoes back the secret we set on the webhook. Fail CLOSED: without
  // the secret we can't verify the sender, so any anonymous POST could drive the
  // bot flow — reject instead of processing. This matches the meta/whatsapp
  // webhooks (503 when their secret is unset); the old `secret && …` guard failed
  // OPEN, skipping the check entirely whenever TELEGRAM_WEBHOOK_SECRET was unset.
  const secret = await getSetting("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    await logError("telegram-webhook", "POST received but TELEGRAM_WEBHOOK_SECRET is not set — rejecting").catch(() => {});
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  // Constant-time: every other secret check here already was.
  if (!secretEquals(req.headers.get("x-telegram-bot-api-secret-token"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let update: {
    update_id?: number;
    message?: { text?: string; chat?: { id?: number } };
    callback_query?: { id: string; data?: string; message?: { chat?: { id?: number } } };
  };
  try {
    update = await req.json();
  } catch {
    return NextResponse.json({ ok: true });
  }

  try {
    await withSystemScope(async () => {
      // Telegram's update_id is stable across retries. Claim it before any bot
      // transition or CRM action so a provider retry cannot execute twice.
      if (!(await claimInboundBotEvent("telegram", String(update.update_id ?? "")))) return;

      if (update.callback_query) {
        const cq = update.callback_query;
        await tgAnswerCallback(cq.id);
        const chatId = cq.message?.chat?.id;
        if (chatId != null && cq.data) await runTelegramFlow(chatId, "", cq.data);
      } else if (update.message?.text) {
        const chatId = update.message.chat?.id;
        if (chatId != null) await runTelegramFlow(chatId, update.message.text);
      }
    });
  } catch {
    // never fail the webhook
  }
  return NextResponse.json({ ok: true });
}
