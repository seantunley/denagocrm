import { prisma } from "./db";
import { logAudit } from "./audit";
import { sendPushToAll } from "./push";
import { inboundCommunicationKey, isDedupeKeyConflict } from "./inboundMessageKey";
import { currentInboundBotEventId } from "./botInboundEvent";
import { resolveTenantActor } from "./tenantActor";
import { currentTenantScope } from "./tenantScope";

export type TelegramSender = { firstName?: string | null; lastName?: string | null; username?: string | null };

/**
 * An inbound Telegram message → the customer's record (gap audit #29).
 *
 * Telegram ran the bot and nothing else: no contact, no timeline row, no inbox
 * thread — a whole channel staff could not see. This is `recordInboundDm` for
 * Telegram: find the contact by chat id (creating one from the sender's name),
 * file the message on it, reopen the thread, and tell the team.
 *
 * The tenant is the webhook's: `withTelegramTenantScope` resolves the bot secret
 * to its workspace and enters that scope whether or not enforcement is on, and a
 * chat id is only unique within one bot — hence the tenant-scoped lookup.
 *
 * Returns the contact so the bot flow can act on the same record.
 */
export async function recordInboundTelegram(input: {
  chatId: string;
  text: string;
  fileUrl?: string;
  from?: TelegramSender;
  /** Telegram's message id, so a redelivery reuses these rows. */
  providerMessageId?: string;
}): Promise<{ contactId: string } | null> {
  const tenantId = currentTenantScope()?.tenantId ?? null;
  if (!tenantId) return null; // the route only runs us inside a resolved scope

  let contact = await prisma.contact.findFirst({
    where: { tenantId, telegramChatId: input.chatId },
    select: { id: true, firstName: true, lastName: true },
  });
  if (!contact) {
    const name = [input.from?.firstName, input.from?.lastName].filter(Boolean).join(" ").trim()
      || (input.from?.username ? `@${input.from.username}` : "");
    const [firstName, ...rest] = (name || "Telegram user").split(/\s+/);
    contact = await prisma.contact.create({
      data: {
        tenantId,
        firstName: firstName || "Telegram",
        lastName: rest.join(" ") || null,
        source: "telegram",
        telegramChatId: input.chatId,
        notes: name ? null : "Created from an inbound Telegram message — name not yet available.",
      },
      select: { id: true, firstName: true, lastName: true },
    });
    await logAudit({
      action: "contact.created",
      summary: "Contact created from an inbound Telegram message",
      contactId: contact.id,
      userName: "System",
    });
  }

  const actor = await resolveTenantActor();
  if (!actor) return { contactId: contact.id };

  const identity = {
    ledgerEventId: currentInboundBotEventId(),
    tenantId,
    channel: "telegram",
    providerId: input.providerMessageId ?? "",
  };
  const rows = [
    ...(input.text ? [{ body: input.text, attachmentUrl: null as string | null, attachmentType: null as string | null }] : []),
    ...(input.fileUrl ? [{ body: "📎 File", attachmentUrl: input.fileUrl, attachmentType: "file" }] : []),
  ];
  let insertedAny = false;
  for (const [index, row] of rows.entries()) {
    const key = inboundCommunicationKey(identity, index === 0 ? undefined : index);
    try {
      // create(), not createMany(): db.ts hooks communication.create to attach
      // the Conversation the inbox threads hang off.
      await prisma.communication.create({
        data: {
          type: "telegram",
          direction: "inbound",
          body: row.body,
          attachmentUrl: row.attachmentUrl,
          attachmentType: row.attachmentType,
          contactId: contact.id,
          userId: actor.id,
          tenantId,
          ...(key ? { dedupeKey: key } : {}),
        },
      });
      insertedAny = true;
    } catch (error) {
      if (!key || !isDedupeKeyConflict(error)) throw error;
    }
  }
  const { reopenThreadOnInbound } = await import("./reopenThread");
  await reopenThreadOnInbound(contact.id, null, "telegram");

  // A pure redelivery must not buzz everyone again.
  if (insertedAny) {
    await sendPushToAll({
      title: "New Telegram message ✈️",
      body: `${contact.firstName}${contact.lastName ? ` ${contact.lastName}` : ""}: ${(input.text || "sent a file").slice(0, 80)}`,
      url: "/inbox",
    }, "dm").catch(() => {});
  }
  return { contactId: contact.id };
}
