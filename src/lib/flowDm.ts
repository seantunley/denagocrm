import { prisma } from "./db";
import { resolveTenantActor } from "./tenantActor";
import { FLOW_MARKER } from "./flowRun";
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
 * Record what the bot said to the customer.
 *
 * WITHOUT THIS THE BOT TALKS OFF THE RECORD. Every reply below is sent through
 * the Page's own token, so the customer sees it in Messenger — and nothing was
 * written to Communication, so it appeared nowhere in the social inbox. Staff
 * would open a thread, see the customer's messages and their own, and have no
 * idea the assistant had already answered — including anything the AI reply path
 * generated, which is not text anyone here wrote or reviewed.
 *
 * The WhatsApp bot has always done this (`logOutbound` in flowRun.ts). This is the
 * same function for the DM channels, which were simply missing it.
 *
 * Recorded only after a send REPORTS SUCCESS, exactly as WhatsApp does: a row for
 * a message Meta rejected would be a different lie in the same place.
 *
 * FLOW_MARKER in `subject` is how the inbox tells a bot reply from a person's.
 */
async function logOutboundDm(
  platform: DmPlatform,
  text: string,
  contactId: string | null,
  actorId: string,
): Promise<void> {
  // The actor is PASSED IN, resolved before anything was sent. It used to be
  // resolved here, after the send, with `if (!actor) return` — so a missing
  // tenant actor meant the customer had the message and the CRM had no record.
  // That is the precise thing this function exists to prevent, and it was the
  // one path that could still do it.
  //
  // A failure here cannot be transactional with Meta — the message is already
  // gone. It is therefore RE-THROWN to the webhook's error log rather than
  // swallowed, so an unrecorded send is discoverable instead of silent.
  await prisma.communication.create({
    data: {
      type: platform,
      direction: "outbound",
      subject: FLOW_MARKER,
      body: text,
      contactId,
      userId: actorId,
    },
  });
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

  // FAIL CLOSED BEFORE SENDING ANYTHING.
  //
  // Without a tenant actor there is nobody to attribute a Communication to, so a
  // reply sent now could not be recorded — the customer would have a message the
  // CRM has never heard of. Resolving it here, before the flow runs, means the
  // bot simply does not speak rather than speaking off the record.
  const actor = await resolveTenantActor();
  if (!actor) {
    console.error(
      `[bot] refusing to reply on ${platform}: no tenant actor, so the reply could not be recorded`,
    );
    return;
  }

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
    if (m.type === "text") {
      const sent = await sendDirectMessage(platform, senderId, m.text);
      if (sent.ok) await logOutboundDm(platform, m.text, contact?.id ?? null, actor.id);
    } else if (m.type === "image") {
      const sent = await sendDirectAttachment(platform, senderId, { type: "image", url: m.url });
      // Always "[image]", never the caption: unlike WhatsApp, the DM channels send
      // the caption as its OWN message, which is recorded below. Folding it in here
      // too would print the caption twice in the timeline.
      if (sent.ok) await logOutboundDm(platform, "🖼 [image]", contact?.id ?? null, actor.id);
      if (m.caption) {
        const caption = await sendDirectMessage(platform, senderId, m.caption);
        if (caption.ok) await logOutboundDm(platform, m.caption, contact?.id ?? null, actor.id);
      }
    } else {
      const sent = await sendDirectQuickReplies(
        platform,
        senderId,
        m.text,
        m.options.map((o) => ({ title: o.label, payload: o.id })),
      );
      // The options are part of what the customer was shown. Recording only the
      // question would put a half of the message in the timeline.
      if (sent.ok) {
        await logOutboundDm(
          platform,
          `${m.text}\n${m.options.map((o) => `• ${o.label}`).join("\n")}`,
          contact?.id ?? null,
          actor.id,
        );
      }
    }
  }
}

// re-export so callers building choices stay consistent with the engine
export { encodeChoice };
