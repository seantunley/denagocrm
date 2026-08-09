import { resolveTenantCredential } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { saveFile } from "./storage";

const OUTBOUND_TIMEOUT_MS = 15_000;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
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

async function readBounded(res: Response): Promise<Buffer | null> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > INBOUND_FILE_MAX_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > INBOUND_FILE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Resolve an inbound Telegram file id through Telegram's authenticated getFile
 * endpoint, enforce a streaming memory cap, and persist the bytes in the same
 * storage layer used by the rest of the CRM. The flow sees OUR storage ref, not
 * Telegram's temporary file URL.
 */
export async function tgPersistInboundFile(
  fileId: string,
  fileName = "telegram-file.bin",
  hintedMimeType?: string,
): Promise<string | null> {
  const t = await token();
  if (!t || !fileId) return null;
  try {
    const metaRes = await fetch(`${api(t, "getFile")}?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!metaRes.ok) return null;
    const meta = await metaRes.json().catch(() => null);
    const filePath: string | undefined = meta?.result?.file_path;
    const declaredSize = Number(meta?.result?.file_size ?? "");
    if (!filePath || (Number.isFinite(declaredSize) && declaredSize > INBOUND_FILE_MAX_BYTES)) return null;

    const fileRes = await fetch(`https://api.telegram.org/file/bot${t}/${filePath.replace(/^\/+/, "")}`, {
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!fileRes.ok) return null;
    const buffer = await readBounded(fileRes);
    if (!buffer) return null;
    const mimeType = hintedMimeType || fileRes.headers.get("content-type") || "application/octet-stream";
    return saveFile(buffer, fileName, mimeType);
  } catch {
    return null;
  }
}
