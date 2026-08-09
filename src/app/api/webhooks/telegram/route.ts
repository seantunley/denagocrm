import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/settings";
import { runTelegramFlow, tgAnswerCallback } from "@/lib/telegram";
import { logError } from "@/lib/errorLog";
import { withSystemScope } from "@/lib/tenantScope";
import { secretEquals } from "@/lib/secretCompare";
import {
  claimInboundBotEvent,
  completeInboundBotEvent,
  InboundBotEventLeasedError,
  retryInboundBotEvent,
} from "@/lib/botInboundEvent";

export async function POST(req: NextRequest) {
  const secret = await getSetting("TELEGRAM_WEBHOOK_SECRET");
  if (!secret) {
    await logError("telegram-webhook", "POST received but TELEGRAM_WEBHOOK_SECRET is not set — rejecting").catch(() => {});
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
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
      const outcome = await claimInboundBotEvent("telegram", String(update.update_id ?? ""));
      if (outcome.status === "completed") return; // genuinely done — ack it.
      if (outcome.status === "unidentified") {
        await logError("telegram-webhook", "Inbound update carried no update_id — skipped, because a redelivery would repeat it unfenced.").catch(() => {});
        return;
      }
      // Leased: the attempt holding it may have died. Ack would retire the
      // provider's redelivery and lose the message, so ask to be sent it again.
      if (outcome.status === "leased") throw new InboundBotEventLeasedError("telegram", String(update.update_id ?? ""));
      const claim = outcome.claim;

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
        await completeInboundBotEvent(claim);
      } catch (error) {
        await retryInboundBotEvent(claim, error).catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    await logError("telegram-webhook", error).catch(() => {});
    return NextResponse.json({ error: "Update processing failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
