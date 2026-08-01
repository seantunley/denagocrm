import { getSetting, resolveTenantCredential } from "./settings";
import { currentTenantScope } from "./tenantScope";
import { generateBotReply } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";

/**
 * Every outbound call is bounded. Node fetch has NO default timeout, so an
 * unresponsive provider holds a webhook handler or a cron sweep open until the
 * platform kills the whole invocation.
 */
const OUTBOUND_TIMEOUT_MS = 15_000;

const api = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

// Telegram has no ChannelIdentity mapping (no per-bot → tenant routing) yet, so
// this is whatever tenant is ambiently in scope (null/global today) — NOT full
// multi-tenant Telegram routing, which is a separate, bigger piece of work.
async function token(): Promise<string | null> {
  return resolveTenantCredential(currentTenantScope()?.tenantId ?? null, "TELEGRAM_BOT_TOKEN");
}

/** Send a Telegram message, optionally with inline-keyboard buttons (menu). */
export async function tgSend(chatId: number | string, text: string, options?: { id: string; label: string }[]) {
  const t = await token();
  if (!t) return;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (options?.length) {
    body.reply_markup = { inline_keyboard: options.map((o) => [{ text: o.label, callback_data: o.id.slice(0, 64) }]) };
  }
  await fetch(api(t, "sendMessage"), {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
}

export async function tgSendPhoto(chatId: number | string, url: string, caption?: string) {
  const t = await token();
  if (!t) return;
  await fetch(api(t, "sendPhoto"), {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, photo: url, ...(caption ? { caption } : {}) }),
  }).catch(() => {});
}

export async function tgAnswerCallback(id: string) {
  const t = await token();
  if (!t) return;
  await fetch(api(t, "answerCallbackQuery"), {
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  }).catch(() => {});
}

export async function setTelegramWebhook(url: string, secret: string): Promise<{ ok: boolean; error?: string }> {
  const t = await token();
  if (!t) return { ok: false, error: "No bot token saved." };
  try {
    const res = await fetch(api(t, "setWebhook"), {
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "callback_query"] }),
    });
    const j = await res.json().catch(() => null);
    return j?.ok ? { ok: true } : { ok: false, error: j?.description ?? "setWebhook failed" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export async function deleteTelegramWebhook() {
  const t = await token();
  if (!t) return;
  await fetch(api(t, "deleteWebhook"), { method: "POST", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) }).catch(() => {});
}

async function tgBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_TG_ENABLED")) === "true";
}

/** Run the active flow for an inbound Telegram update. */
export async function runTelegramFlow(chatId: number | string, text: string, callbackData?: string) {
  if (!(await tgBotEnabled())) return;
  const result = await advanceFlow("telegram", String(chatId), { text, choiceId: callbackData }, (state) => ({
    dynamicAnswer: (s) => (s === "colours" ? coloursList() : priceList()),
    aiReply: async (vars) => {
      const ai = await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false });
      return ai ?? { reply: "Let me get a team member to help 👍", handoff: true };
    },
    handoff: async () => {
      await sendPushToAll({ title: "Telegram needs you 🙋", body: "The assistant handed a chat over.", url: "/inbox" }, "bot_handoff").catch(() => {});
    },
    ...crmActions("telegram", { contactId: null, leadId: null }),
  }), greetingVars(null));
  if (result.suppressed) return;
  for (const m of result.messages) {
    if (m.type === "text") await tgSend(chatId, m.text);
    else if (m.type === "image") await tgSendPhoto(chatId, m.url, m.caption);
    else await tgSend(chatId, m.text, m.options.map((o) => ({ id: o.id, label: o.label })));
  }
}
