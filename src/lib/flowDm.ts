import { prisma } from "./db";
import { getSetting } from "./settings";
import { generateBotReply } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { sendPushToAll } from "./push";
import { sendDirectMessage, sendDirectQuickReplies, sendDirectAttachment, type DmPlatform } from "./messenger";
import { advanceFlow, greetingVars } from "./flowSession";
import { crmActions } from "./flowActions";
import { choiceId as encodeChoice } from "./flow";

async function dmBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_DM_ENABLED")) === "true";
}

/**
 * Runs the active flow for an inbound Messenger / Instagram DM and replies,
 * rendering menu options as quick-reply chips. `payload` is the tapped
 * quick-reply value, if any. No-op unless the DM bot is enabled.
 */
export async function runDmFlow(
  platform: DmPlatform,
  senderId: string,
  text: string,
  payload?: string
): Promise<void> {
  if (!senderId) return;
  if (!(await dmBotEnabled())) return;

  // Personalise: greet a known customer by name.
  const contact = await prisma.contact.findFirst({
    where: platform === "instagram" ? { instagramId: senderId } : { messengerPsid: senderId },
  });

  const result = await advanceFlow(platform, senderId, { text, choiceId: payload }, (state) => ({
    dynamicAnswer: (source) => (source === "colours" ? coloursList() : priceList()),
    aiReply: async (vars) => {
      const ai = await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false });
      return ai ?? { reply: "Let me get one of our team to help — I'll pass this on now 👍", handoff: true };
    },
    handoff: async () => {
      await sendPushToAll({ title: `${platform === "instagram" ? "Instagram" : "Messenger"} needs you 🙋`, body: "The assistant handed a chat over.", url: "/inbox" }, "bot_handoff").catch(() => {});
    },
    ...crmActions(platform, { contactId: contact?.id ?? null, leadId: null }),
  }), greetingVars(contact?.firstName ?? null));

  if (result.suppressed) return;
  for (const m of result.messages) {
    if (m.type === "text") await sendDirectMessage(platform, senderId, m.text);
    else if (m.type === "image") {
      await sendDirectAttachment(platform, senderId, { type: "image", url: m.url });
      if (m.caption) await sendDirectMessage(platform, senderId, m.caption);
    } else await sendDirectQuickReplies(platform, senderId, m.text, m.options.map((o) => ({ title: o.label, payload: o.id })));
  }
}

// re-export so callers building choices stay consistent with the engine
export { encodeChoice };
