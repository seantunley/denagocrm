import { getSetting } from "./settings";
import { generateBotReply } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import { enqueueBotMessages, flushBotOutboxConversation } from "./botOutbox";

// Keep the public transport surface stable for existing settings/webhook callers.
export {
  tgSend,
  tgSendPhoto,
  tgAnswerCallback,
  setTelegramWebhook,
  deleteTelegramWebhook,
} from "./telegramTransport";

async function tgBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_TG_ENABLED")) === "true";
}

/** Run the published flow for an inbound Telegram update. */
export async function runTelegramFlow(chatId: number | string, text: string, callbackData?: string) {
  if (!(await tgBotEnabled())) return;
  const key = String(chatId);
  const result = await advanceFlow(
    "telegram",
    key,
    { text, choiceId: callbackData },
    (state) => ({
      dynamicAnswer: (s) => (s === "colours" ? coloursList() : priceList()),
      aiReply: async (vars) => {
        const ai = await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false });
        return ai ?? { reply: "Let me get a team member to help 👍", handoff: true };
      },
      handoff: async () => {
        await sendPushToAll({ title: "Telegram needs you 🙋", body: "The assistant handed a chat over.", url: "/inbox" }, "bot_handoff").catch(() => {});
      },
      ...crmActions("telegram", { contactId: null, leadId: null }),
    }),
    greetingVars(null),
    async (messages) => {
      await enqueueBotMessages({ channel: "telegram", key, messages });
    },
  );

  if (result.suppressed) return;
  // Immediate best effort for conversational latency. A failure remains queued
  // for the bot-outbox cron rather than being lost.
  await flushBotOutboxConversation("telegram", key);
}
