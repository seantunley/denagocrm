import { resolveTenantCredential } from "./settings";
import { currentTenantScope } from "./tenantScope";

const OUTBOUND_TIMEOUT_MS = 15_000;
const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

async function token(): Promise<string | null> {
  return resolveTenantCredential(currentTenantScope()?.tenantId ?? null, "TELEGRAM_BOT_TOKEN");
}

export type TelegramSendResult = { ok: boolean; error?: string };

async function postTelegram(method: string, body: Record<string, unknown>): Promise<TelegramSendResult> {
  const t = await token();
  if (!t) return { ok: false, error: "Telegram bot token is not configured." };
  try {
    const res = await fetch(api(t, method), {
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return res.ok && json?.ok !== false
      ? { ok: true }
      : { ok: false, error: json?.description ?? `Telegram API error ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Telegram network error" };
  }
}

export async function tgSend(
  chatId: number | string,
  text: string,
  options?: { id: string; label: string }[],
): Promise<TelegramSendResult> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.length) {
    body.reply_markup = {
      inline_keyboard: options.map((o) => [{ text: o.label, callback_data: o.id.slice(0, 64) }]),
    };
  }
  return postTelegram("sendMessage", body);
}

export async function tgSendPhoto(
  chatId: number | string,
  url: string,
  caption?: string,
): Promise<TelegramSendResult> {
  return postTelegram("sendPhoto", { chat_id: chatId, photo: url, ...(caption ? { caption } : {}) });
}

export async function tgAnswerCallback(id: string): Promise<void> {
  await postTelegram("answerCallbackQuery", { callback_query_id: id });
}

export async function setTelegramWebhook(url: string, secret: string): Promise<TelegramSendResult> {
  return postTelegram("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
  });
}

export async function deleteTelegramWebhook(): Promise<void> {
  await postTelegram("deleteWebhook", {});
}
