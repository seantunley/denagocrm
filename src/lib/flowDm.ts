import { prisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { getSetting } from "./settings";
import { generateBotReply } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import { choiceId as encodeChoice } from "./flow";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";
import type { DmPlatform } from "./messenger";

async function dmBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_DM_ENABLED")) === "true";
}

/** Run the published Messenger / Instagram flow with durable outbound delivery. */
export async function runDmFlow(
  platform: DmPlatform,
  senderId: string,
  text: string,
  payload?: string,
): Promise<void> {
  if (!senderId) return;
  if (!(await dmBotEnabled())) return;

  const actor = await resolveTenantActor();
  if (!actor) {
    console.error(`[bot] refusing to reply on ${platform}: no tenant actor, so the reply could not be recorded`);
    return;
  }

  const contact = await prisma.contact.findFirst({
    where: platform === "instagram" ? { instagramId: senderId } : { messengerPsid: senderId },
  });

  const result = await advanceFlow(
    platform,
    senderId,
    { text, choiceId: payload },
    (state) => ({
      dynamicAnswer: (source) => (source === "colours" ? coloursList() : priceList()),
      aiReply: async (vars) => {
        const ai = await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false });
        return ai ?? { reply: "Let me get one of our team to help — I'll pass this on now 👍", handoff: true };
      },
      handoff: async () => {
        await sendPushToAll({ title: `${platform === "instagram" ? "Instagram" : "Messenger"} needs you 🙋`, body: "The assistant handed a chat over.", url: "/inbox" }, "bot_handoff").catch(() => {});
      },
      ...crmActions(platform, { contactId: contact?.id ?? null, leadId: null }),
    }),
    greetingVars(contact?.firstName ?? null),
    async (messages, tx, tenantId) => {
      await enqueueBotMessagesTx(tx, tenantId, {
        channel: platform,
        key: senderId,
        messages,
        contactId: contact?.id ?? null,
        actorId: actor.id,
      });
    },
  );

  if (result.suppressed) return;
  await flushBotOutboxConversation(platform, senderId);
}

export { encodeChoice };
