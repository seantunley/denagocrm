import "server-only";
import { prisma } from "./db";

export type SendGridEvent = {
  event?: unknown;
  timestamp?: unknown;
  sg_event_id?: unknown;
  sg_message_id?: unknown;
  crm_recipient_id?: unknown;
  url?: unknown;
  reason?: unknown;
  response?: unknown;
  status?: unknown;
  type?: unknown;
  sg_machine_open?: unknown;
  attempt?: unknown;
  tls?: unknown;
};

export function sendGridRecipientId(event: SendGridEvent): string | null {
  return typeof event.crm_recipient_id === "string" && event.crm_recipient_id.length <= 128
    ? event.crm_recipient_id
    : null;
}

function text(value: unknown, max = 1_000): string | null {
  return typeof value === "string" && value ? value.slice(0, max) : null;
}

function eventType(event: SendGridEvent): string | null {
  const value = text(event.event, 64)?.toLowerCase();
  return value && /^[a-z_]+$/.test(value) ? value : null;
}

/**
 * Persist one provider event and update materialised campaign totals. The event
 * row is the idempotency gate; SendGrid retries never double-increment totals.
 */
export async function applySendGridEvent(event: SendGridEvent): Promise<boolean> {
  const recipientId = sendGridRecipientId(event);
  const type = eventType(event);
  const providerEventId = text(event.sg_event_id, 255);
  const timestamp = Number(event.timestamp);
  if (!recipientId || !type || !providerEventId || !Number.isFinite(timestamp)) return false;

  const recipient = await prisma.campaignRecipient.findUnique({ where: { id: recipientId } });
  if (!recipient) return false;
  const occurredAt = new Date(timestamp * 1000);
  if (Number.isNaN(occurredAt.getTime())) return false;

  try {
    await prisma.campaignEvent.create({
      data: {
        campaignId: recipient.campaignId,
        recipientId: recipient.id,
        provider: "sendgrid",
        providerEventId,
        type,
        occurredAt,
        url: text(event.url, 2_000),
        reason: text(event.reason),
        response: text(event.response),
        smtpCode: text(event.status, 32),
        metadata: {
          messageId: text(event.sg_message_id, 255),
          bounceType: text(event.type, 64),
          machineOpen: event.sg_machine_open === true,
          attempt: typeof event.attempt === "string" || typeof event.attempt === "number"
            ? String(event.attempt)
            : null,
          tls: typeof event.tls === "boolean" ? event.tls : null,
        },
      },
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return false;
    }
    throw error;
  }

  try {
    if (type === "processed") {
      await prisma.campaignRecipient.updateMany({
        where: {
          id: recipient.id,
          processedAt: null,
          status: { notIn: ["delivered", "bounced", "dropped", "failed", "suppressed"] },
        },
        data: { processedAt: occurredAt, status: "processed" },
      });
    } else if (type === "delivered") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, deliveredAt: null },
        data: { deliveredAt: occurredAt, status: "delivered", error: null },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { deliveredCount: { increment: 1 } },
        });
      }
    } else if (type === "deferred") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, deferredAt: null, deliveredAt: null },
        data: {
          deferredAt: occurredAt,
          status: "deferred",
          error: text(event.response) || text(event.reason),
        },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { deferredCount: { increment: 1 } },
        });
      }
    } else if (type === "bounce") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, bouncedAt: null },
        data: {
          bouncedAt: occurredAt,
          status: "bounced",
          error: text(event.reason) || text(event.response),
        },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { bouncedCount: { increment: 1 } },
        });
      }
    } else if (type === "dropped" || type === "blocked") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, droppedAt: null },
        data: {
          droppedAt: occurredAt,
          status: "dropped",
          error: text(event.reason) || text(event.response),
        },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { droppedCount: { increment: 1 } },
        });
      }
    } else if (type === "spamreport") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, complainedAt: null },
        data: { complainedAt: occurredAt },
      });
      await prisma.contact.update({
        where: { id: recipient.contactId },
        data: { marketingOptOut: true },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { complaintCount: { increment: 1 } },
        });
        await prisma.consentRecord.create({
          data: {
            contactId: recipient.contactId,
            type: "marketing",
            granted: false,
            source: "sendgrid_spam_report",
            note: "Recipient reported this campaign as spam.",
          },
        });
      }
    } else if (type === "unsubscribe" || type === "group_unsubscribe") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, unsubscribedAt: null },
        data: { unsubscribedAt: occurredAt },
      });
      await prisma.contact.update({
        where: { id: recipient.contactId },
        data: { marketingOptOut: true },
      });
      if (first.count > 0) {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { unsubscribeCount: { increment: 1 } },
        });
        await prisma.consentRecord.create({
          data: {
            contactId: recipient.contactId,
            type: "marketing",
            granted: false,
            source: "sendgrid_unsubscribe",
            note: "Recipient unsubscribed through the email provider.",
          },
        });
      }
    } else if (type === "open" && event.sg_machine_open !== true) {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, openedAt: null },
        data: { openedAt: occurredAt, openCount: { increment: 1 } },
      });
      if (first.count === 0) {
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { openCount: { increment: 1 } },
        });
      } else {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { openCount: { increment: 1 } },
        });
      }
    } else if (type === "click") {
      const first = await prisma.campaignRecipient.updateMany({
        where: { id: recipient.id, clickedAt: null },
        data: { clickedAt: occurredAt, clickCount: { increment: 1 } },
      });
      if (first.count === 0) {
        await prisma.campaignRecipient.update({
          where: { id: recipient.id },
          data: { clickCount: { increment: 1 } },
        });
      } else {
        await prisma.campaign.update({
          where: { id: recipient.campaignId },
          data: { clickCount: { increment: 1 } },
        });
      }
    }
    return true;
  } catch (error) {
    // Remove the idempotency gate so a provider retry can finish a partial write.
    await prisma.campaignEvent.delete({
      where: { provider_providerEventId: { provider: "sendgrid", providerEventId } },
    }).catch(() => {});
    throw error;
  }
}
