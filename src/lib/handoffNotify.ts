import "server-only";
import { basePrisma, prisma } from "./db";
import { getSetting } from "./settings";
import { logAudit } from "./audit";
import { logError } from "./errorLog";
import { sendPushToAll } from "./push";
import { currentTenantScope } from "./tenantScope";
import { tenantOrigin } from "./tenantOrigin";
import { hasAnyPermission } from "./permissions";
import { assistantUserFor } from "./assistantUser";
import { assistantWhatsAppOn, sendUpdatesToLinkedPhone } from "./assistantWhatsApp";
import {
  ASSISTANT_WHATSAPP_HANDOFF_KEY,
  ASSISTANT_WHATSAPP_HANDOFF_TO_KEY,
  HANDOFF_SEND_WAIT_MS,
  handoffRecipient,
  handoffText,
  whatsappHandoffOn,
} from "./assistantWhatsAppRules";

/*
 * THE CHATBOT HAS HANDED A CONVERSATION TO A PERSON — give that person the
 * customer.
 *
 * The chatbot's job on the business number is to filter: spam and junk never
 * get this far, and an enquiry that does has been asked what it wants. What
 * Sean asked for (2026-10-12) is the step after that: "a configurable/optional
 * handoff with the chat to my number with customer details, so I can chat to
 * them. The handoff must be logged in the CRM."
 *
 * So the person it is handed to receives, on the WhatsApp they linked: who the
 * customer is and how to reach them, what they want, the chat so far, a link
 * that opens a WhatsApp chat with the customer from their own phone, and a link
 * to the record. They carry on the conversation themselves.
 *
 * WHAT THE CRM RECORDS is the handoff — who it went to, and when — on the
 * lead's or customer's own record and in the audit trail. A conversation the
 * person then has from another number happens outside the CRM, and the settings
 * page says so.
 *
 * It rides on what already sends a scheduled briefing to a linked phone — an
 * AssistantTurn, delivered by sendUpdatesToLinkedPhone — and so inherits all of
 * it: the phone must be a VERIFIED link with a live sign-in and must not be a
 * customer's number (customer details never go to a number somebody typed in);
 * WhatsApp's 24-hour rule is respected, with the "you have an update" template
 * standing in outside it; each one is claimed, sent whole and retried by the
 * half-hourly sweep; and each person's own "send my updates to this phone"
 * switch applies. It is also in their Ask history.
 */

export type Handoff = {
  /** As a person reads it: "WhatsApp", "Messenger", "Instagram", "Telegram". */
  channel: string;
  /** What the push says: the bot's one-line summary or reason. */
  body: string;
  /** Where the record is, as a path in the CRM. */
  url: string;
  /** Who the customer is, as far as the channel knows. `waDigits`: their WhatsApp number, when this is WhatsApp. */
  customer?: { contactId: string | null; leadId: string | null; waDigits?: string | null };
  /** What the customer answered to the chatbot's questions. */
  answers?: Record<string, string>;
  /**
   * The conversation so far, oldest first, as the bot holds it. A function,
   * because reading it can cost a query and it is only wanted when the handoff
   * really goes to a phone.
   */
  chat?: () => BotChat | Promise<BotChat>;
};
type BotChat = readonly { role: "user" | "assistant"; content: string }[];

/**
 * Never rejects: this hangs off the bot's turn, and a handoff that cannot be
 * sent to a phone must not cost the customer their reply.
 */
export async function notifyHandoff(handoff: Handoff): Promise<void> {
  await sendPushToAll({ title: `${handoff.channel} needs you 🙋`, body: handoff.body, url: handoff.url }, "bot_handoff").catch(() => {});
  await tellLinkedPhones(handoff).catch((error: unknown) => logError("bot-handoff", "sending the handoff to linked phones failed", error instanceof Error ? error.name : "unknown").catch(() => {}));
}

/** The customer as the CRM knows them, through the workspace-scoped client: another workspace's record reads as missing. */
async function customerDetails(customer: Handoff["customer"]): Promise<{ name: string | null; phone: string | null; email: string | null }> {
  const contact = customer?.contactId
    ? await prisma.contact.findUnique({ where: { id: customer.contactId }, select: { firstName: true, lastName: true, phone: true, email: true } })
    : null;
  if (contact) return { name: [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim() || null, phone: contact.phone, email: contact.email };
  const lead = customer?.leadId ? await prisma.lead.findUnique({ where: { id: customer.leadId }, select: { name: true, phone: true, email: true } }) : null;
  return { name: lead?.name ?? null, phone: lead?.phone ?? null, email: lead?.email ?? null };
}

async function tellLinkedPhones(handoff: Handoff): Promise<void> {
  // The bot runs inside the channel's own workspace. No real workspace, no handoff to a phone.
  const scope = currentTenantScope();
  if (!scope || scope.system || !scope.tenantId) return;
  const tenantId = scope.tenantId;
  // The owner's switch for THIS, and the one that lets staff use WhatsApp at all.
  if (!whatsappHandoffOn(await getSetting(ASSISTANT_WHATSAPP_HANDOFF_KEY).catch(() => null))) return;
  if (!(await assistantWhatsAppOn())) return;

  // One chosen person, or everyone. Either way only a VERIFIED linked phone, with updates wanted.
  const only = handoffRecipient(await getSetting(ASSISTANT_WHATSAPP_HANDOFF_TO_KEY).catch(() => null));
  const links = await basePrisma.assistantPhoneLink.findMany({
    where: { tenantId, verifiedAt: { not: null }, waId: { not: null }, updatesOnWhatsApp: true, ...(only ? { userId: only } : {}) },
    select: { userId: true },
    take: 50,
  });
  if (links.length === 0) return;

  const details = await customerDetails(handoff.customer);
  const waDigits = handoff.customer?.waDigits?.replace(/\D/g, "") || null;
  const origin = await tenantOrigin(tenantId).catch(() => "");
  const answer = handoffText({
    summary: handoff.body,
    // On WhatsApp the number they wrote from IS how to reach them, whatever the record holds.
    customer: { ...details, phone: details.phone ?? (waDigits ? `+${waDigits}` : null) },
    answers: handoff.answers ?? {},
    // Without the chat the handoff is still worth sending: a failed read costs the transcript, not the handoff.
    // (Called inside the async function, so a reader that throws at once is caught like one that rejects.)
    chat: (await (async (): Promise<BotChat> => (await handoff.chat?.()) ?? [])().catch((): BotChat => [])).map((message) => ({
      from: message.role === "user" ? ("customer" as const) : ("bot" as const),
      text: message.content,
    })),
    waDigits,
    crmUrl: `${origin}${handoff.url}`,
  });

  const told: { id: string; name: string }[] = [];
  for (const { userId } of links) {
    // Still a member who may use the assistant — and who may open the inbox,
    // since a customer's conversation is what they are being given.
    const user = await assistantUserFor(userId);
    if (!user || !(await hasAnyPermission(user, "inbox.view", "inbox.reply"))) continue;
    await basePrisma.assistantTurn.create({
      data: { tenantId, userId, question: `${handoff.channel} chat handed to you`, answer, source: "handoff" },
    });
    told.push({ id: userId, name: user.name });
  }
  if (told.length === 0) return;

  // LOGGED, on the customer's own record: that the chatbot handed them over, and to whom.
  // Names of staff only — nothing of what the customer said goes into the audit summary.
  await logAudit({
    action: "bot.handoff_to_whatsapp",
    summary: `Chatbot handed this ${handoff.channel} conversation to ${told.map((person) => person.name).join(", ")} on WhatsApp, with the customer's details and the chat so far`,
    contactId: handoff.customer?.contactId ?? undefined,
    leadId: handoff.customer?.leadId ?? undefined,
    userName: "Chatbot",
  });

  // SENT NOW, but the customer does not wait on it. This runs inside the bot's
  // own turn, before the customer's reply is queued, and a send to WhatsApp can
  // take its whole timeout. So it is given a moment and then left to finish on
  // its own: if the request ends first, the handoff is still waiting, its claim
  // expires, and the half-hourly sweep sends it.
  const sending = Promise.all(told.map((person) => sendUpdatesToLinkedPhone(tenantId, person.id))).catch(() => {});
  await Promise.race([sending, new Promise((resolve) => setTimeout(resolve, HANDOFF_SEND_WAIT_MS))]);
}
