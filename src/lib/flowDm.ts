import { prisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { getSetting } from "./settings";
import { generateBotReply, routeBotChoice } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import { choiceId as encodeChoice, type FlowHandoffContext } from "./flow";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";
import type { DmPlatform } from "./messenger";

async function dmBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_DM_ENABLED")) === "true";
}
function handoffBody(context?: FlowHandoffContext): string {
  if (context?.summary) return `${context.summary}${context.reason ? ` · ${context.reason}` : ""}`.slice(0, 220);
  if (context?.reason) return `Handoff: ${context.reason}`.slice(0, 220);
  return "The assistant handed a chat over.";
}

export async function runDmFlow(platform: DmPlatform, senderId: string, text: string, payload?: string, fileUrl?: string): Promise<void> {
  if (!senderId || !(await dmBotEnabled())) return;
  const actor = await resolveTenantActor();
  if (!actor) { console.error(`[bot] refusing to reply on ${platform}: no tenant actor, so the reply could not be recorded`); return; }
  const contact = await prisma.contact.findFirst({ where: platform === "instagram" ? { instagramId: senderId } : { messengerPsid: senderId } });

  const result = await advanceFlow(
    platform,
    senderId,
    { text, choiceId: payload, fileUrl },
    (state) => ({
      dynamicAnswer: (source) => source === "colours" ? coloursList() : priceList(),
      routeChoice: ({ prompt, text: freeText, options }) => routeBotChoice({ prompt, text: freeText, options }),
      aiReply: async (vars) => (await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false })) ?? { reply: "Let me get one of our team to help — I'll pass this on now 👍", handoff: true, confidence: "low", intent: "unknown", handoffReason: "AI unavailable" },
      handoff: async (_vars, context) => { await sendPushToAll({ title: `${platform === "instagram" ? "Instagram" : "Messenger"} needs you 🙋`, body: handoffBody(context), url: "/inbox" }, "bot_handoff").catch(() => {}); },
      ...crmActions(platform, { contactId: contact?.id ?? null, leadId: null }),
    }),
    greetingVars(contact?.firstName ?? null),
    async (messages, tx, tenantId, flowVersionId) => {
      await enqueueBotMessagesTx(tx, tenantId, { channel: platform, key: senderId, messages, flowVersionId, contactId: contact?.id ?? null, actorId: actor.id });
    },
  );
  if (!result.suppressed) await flushBotOutboxConversation(platform, senderId);
}

export { encodeChoice };
