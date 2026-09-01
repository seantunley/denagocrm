import { getSetting } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { saveFile } from "./storage";

const OUTBOUND_TIMEOUT_MS = 15_000;
const INBOUND_FILE_MAX_BYTES = 20 * 1024 * 1024;
const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

/**
 * The acting workspace's bot token, from ITS OWN AppSetting row.
 *
 * ── WHY NOT resolveTenantCredential ─────────────────────────────────────────
 *
 * That helper is for the override mechanism, and it does this:
 *
 *     const override = await lookupOverride(tenantId, key);
 *     if (override !== null) return override;
 *     if (tenantId !== DEFAULT_TENANT_ID) return null;   // <-- here
 *     return getSetting(key);
 *
 * A non-founding tenant with no override gets NULL and never reaches its own
 * AppSetting row. But Telegram does not use overrides at all: `connectTelegram`
 * writes the token AND the per-tenant webhook secret through `putSetting`,
 * which scopes to the acting workspace, and `resolveTelegramTenant` identifies
 * an inbound update by scanning those same per-tenant secret rows.
 *
 * So reading through the override helper meant tenant B could connect a bot,
 * see the token stored, and have every send and the webhook registration itself
 * report "not configured" — the whole channel dead for everyone except the
 * founding tenant. `getSetting` reads the acting tenant's row, which is exactly
 * where the connect flow put it, and makes the read side agree with the write
 * side.
 *
 * Legacy override rows are therefore no longer consulted for Telegram. They are
 * left in place rather than deleted — they are dead data now, and removing
 * stored credentials belongs in a deliberate cleanup rather than a side effect
 * of this change.
 */
async function token(): Promise<string | null> {
  return getSetting("TELEGRAM_BOT_TOKEN");
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
    // No parent record yet (the flow decides what to do with the file afterwards)
    // and no session — but Telegram is the one channel whose chokepoint enters a
    // REAL tenant scope even while enforcement is dormant: withTelegramTenantScope
    // resolves the per-tenant webhook secret and runs the whole update inside that
    // workspace's scope. So the scope IS the owner here, and reading it invents
    // nothing. Its other branch (a founding-tenant secret on a single-tenant
    // install) enters no scope, and null keeps the legacy flat path this file
    // lands on today.
    return saveFile(buffer, fileName, mimeType, currentTenantScope()?.tenantId ?? null);
  } catch {
    return null;
  }
}
