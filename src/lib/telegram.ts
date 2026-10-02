import { getSetting } from "./settings";
import { generateBotReply, routeBotChoice } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import type { FlowHandoffContext } from "./flow";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";
import { getCompanyProfile } from "./companyProfile";
import { prisma } from "./db";
import { currentTenantScope } from "./tenantScope";
import { resolveTenantActor } from "./tenantActor";

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
  // The record recordInboundTelegram filed this chat against, so the bot's CRM
  // actions and its replies land on the same customer (gap audit #29). Scoped to
  // the webhook's tenant: a chat id is only unique within one bot.
  const tenantId = currentTenantScope()?.tenantId ?? null;
  const contact = tenantId
    ? await prisma.contact.findFirst({ where: { tenantId, telegramChatId: key }, select: { id: true, firstName: true } })
    : null;
  // Without an actor the outbox cannot log the bot's replies on the timeline.
  const actor = await resolveTenantActor();
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
      ...crmActions("telegram", { contactId: contact?.id ?? null, leadId: null }),
    }),
    greetingVars(contact?.firstName ?? null, (await getCompanyProfile()).name),
    async (messages, tx, tenantId, flowVersionId) => {
      await enqueueBotMessagesTx(tx, tenantId, { channel: "telegram", key, messages, flowVersionId, contactId: contact?.id ?? null, actorId: actor?.id });
    },
    startRef ? { referralRef: startRef } : undefined,
  );
  if (!result.suppressed) await flushBotOutboxConversation("telegram", key);
}
