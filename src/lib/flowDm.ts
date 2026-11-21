import { prisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { getSetting } from "./settings";
import { generateBotReply, routeBotChoice } from "./botAi";
import { priceList, coloursList } from "./botAnswers";
import { notifyHandoff } from "./handoffNotify";
import { advanceFlow, greetingVars, type SessionState } from "./flowSession";
import type { FlowCtx } from "./flow";
import { crmActions } from "./flowActions";
import { choiceId as encodeChoice, type FlowHandoffContext } from "./flow";
import { flushBotOutboxConversation } from "./botOutbox";
import { enqueueBotMessagesTx } from "./botOutboxWrite";
import type { DmPlatform } from "./messenger";
import type { FlowEntryContext } from "./flowRouting";
import { getCompanyProfile } from "./companyProfile";
import { chatbotOpenNow } from "./chatbotHours";
import { instagramFollowsUs } from "./instagramFollow";

async function dmBotEnabled(): Promise<boolean> {
  return (await getSetting("BOT_ENABLED")) === "true" && (await getSetting("BOT_DM_ENABLED")) === "true";
}
function handoffBody(context?: FlowHandoffContext): string {
  if (context?.summary) return `${context.summary}${context.reason ? ` · ${context.reason}` : ""}`.slice(0, 220);
  if (context?.reason) return `Handoff: ${context.reason}`.slice(0, 220);
  return "The assistant handed a chat over.";
}

/** What a Messenger / Instagram flow can do, for one person (also the comment-started flow: lib/instagramCommentFlow.ts). */
export function dmFlowCtx(platform: DmPlatform, senderId: string, contactId: string | null): (state: SessionState) => FlowCtx {
  return (state) => ({
    dynamicAnswer: (source) => source === "colours" ? coloursList() : priceList(),
    routeChoice: ({ prompt, text: freeText, options }) => routeBotChoice({ prompt, text: freeText, options }),
    openNow: (holidaysClosed) => chatbotOpenNow(holidaysClosed),
    // {{follows_us}} — Instagram only (the follow gate).
    ...(platform === "instagram" ? { followsUs: () => instagramFollowsUs(senderId) } : {}),
    aiReply: async (vars) => (await generateBotReply({ history: state.msgs, customerName: vars.name ?? null, isCustomer: false })) ?? { reply: "Let me get one of our team to help — I'll pass this on now 👍", handoff: true, confidence: "low", intent: "unknown", handoffReason: "AI unavailable" },
    handoff: async (vars, context) => { await notifyHandoff({ channel: platform === "instagram" ? "Instagram" : "Messenger", body: handoffBody(context), url: "/inbox", customer: { contactId, leadId: null }, answers: vars, chat: () => state.msgs }); },
    ...crmActions(platform, { contactId, leadId: null }),
  });
}

export async function runDmFlow(platform: DmPlatform, senderId: string, text: string, payload?: string, fileUrl?: string, entryContext?: FlowEntryContext): Promise<void> {
  if (!senderId || !(await dmBotEnabled())) return;
  const actor = await resolveTenantActor();
  if (!actor) { console.error(`[bot] refusing to reply on ${platform}: no tenant actor, so the reply could not be recorded`); return; }
  const contact = await prisma.contact.findFirst({ where: platform === "instagram" ? { instagramId: senderId } : { messengerPsid: senderId } });

  const result = await advanceFlow(
    platform,
    senderId,
    { text, choiceId: payload, fileUrl },
    dmFlowCtx(platform, senderId, contact?.id ?? null),
    greetingVars(contact?.firstName ?? null, (await getCompanyProfile()).name),
    async (messages, tx, tenantId, flowVersionId) => {
      await enqueueBotMessagesTx(tx, tenantId, { channel: platform, key: senderId, messages, flowVersionId, contactId: contact?.id ?? null, actorId: actor.id });
    },
    entryContext,
  );
  if (!result.suppressed) await flushBotOutboxConversation(platform, senderId);
}

export { encodeChoice };
