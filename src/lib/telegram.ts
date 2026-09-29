import { getSetting } from "./settings";
import { generateBotReply, routeBotChoice } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import type { FlowHandoffContext } from "./flow";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";

export { tgSend, tgSendPhoto, tgAnswerCallback, setTelegramWebhook, deleteTelegramWebhook } from "./telegramTransport";

async function tgBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_TG_ENABLED")) === "true";
}
function handoffBody(context?: FlowHandoffContext): string {
  if (context?.summary) return `${context.summary}${context.reason ? ` · ${context.reason}` : ""}`.slice(0, 220);
  if (context?.reason) return `Handoff: ${context.reason}`.slice(0, 220);
  return "The assistant handed a chat over.";
}

export async function runTelegramFlow(chatId: number | string, text: string, callbackData?: string, fileUrl?: string) {
  if (!(await tgBotEnabled())) return;
  const key = String(chatId);
  const startRef = text.match(/^\/start(?:\s+(.+))?$/i)?.[1]?.trim() || undefined;
  const result = await advanceFlow(
    "telegram",
    key,
    { text, choiceId: callbackData, fileUrl },
    (state) => ({
      dynamicAnswer: (s) => s === "colours" ? coloursList() : priceList(),
      routeChoice: ({ prompt, text: freeText, options }) => routeBotChoice({ prompt, text: freeText, options }),
      aiReply: async (vars) => (await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false })) ?? { reply: "Let me get a team member to help 👍", handoff: true, confidence: "low", intent: "unknown", handoffReason: "AI unavailable" },
      handoff: async (_vars, context) => { await sendPushToAll({ title: "Telegram needs you 🙋", body: handoffBody(context), url: "/inbox" }, "bot_handoff").catch(() => {}); },
      ...crmActions("telegram", { contactId: null, leadId: null }),
    }),
    greetingVars(null),
    async (messages, tx, tenantId, flowVersionId) => {
      await enqueueBotMessagesTx(tx, tenantId, { channel: "telegram", key, messages, flowVersionId });
    },
    startRef ? { referralRef: startRef } : undefined,
  );
  if (!result.suppressed) await flushBotOutboxConversation("telegram", key);
}
