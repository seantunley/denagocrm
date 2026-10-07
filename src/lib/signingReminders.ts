import "server-only";

import { prisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { getSetting } from "@/lib/settings";
import { notifyRecipient } from "@/lib/signing/dispatch";

/**
 * The workspace owner's switch (Settings → Signing security). OFF unless they
 * turn it on: a reminder is a message to a customer that nobody pressed Send
 * on, and it went out to every signer by default (a customer got a WhatsApp
 * nudge on Q-1022 three days after it was sent). "Resend" by hand is unaffected.
 */
export const SIGNING_AUTO_REMINDERS_KEY = "SIGNING_AUTO_REMINDERS";

export async function signingAutoRemindersOn(): Promise<boolean> {
  // A setting that can't be read means "don't send", not "send".
  return (await getSetting(SIGNING_AUTO_REMINDERS_KEY).catch(() => null)) === "true";
}
// (The register — automationRegister.ts — lists this switch with every other one.)

const REMINDER_DELAY_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CANDIDATES_PER_RUN = 100;
const MAX_REMINDERS_PER_RUN = 25;
const LIVE_REQUEST_STATUSES = ["sent", "viewed", "in_progress"] as const;
const REMINDABLE_RECIPIENT_STATUSES = ["sent", "viewed"] as const;

/**
 * Send one automatic reminder to signer recipients whose own latest delivery
 * happened at least three days ago. Recipient delivery events are used instead
 * of SignatureRequest.sentAt so sequential signers get a full reminder window
 * after their turn actually starts.
 */
export async function runSignatureRequestReminders(): Promise<number> {
  if (!(await signingAutoRemindersOn())) return 0;
  const cutoff = new Date(Date.now() - REMINDER_DELAY_MS);
  const candidates = await prisma.signatureRecipient.findMany({
    where: {
      role: "signer",
      status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
      remindedAt: null,
      request: {
        is: {
          deletedAt: null,
          status: { in: [...LIVE_REQUEST_STATUSES] },
        },
      },
    },
    select: { id: true },
    take: MAX_CANDIDATES_PER_RUN,
  });

  if (candidates.length === 0) return 0;

  const latestDeliveries = await prisma.signatureEvent.groupBy({
    by: ["recipientId"],
    where: {
      recipientId: { in: candidates.map((recipient) => recipient.id) },
      type: { in: ["sent", "delivered"] },
    },
    _max: { createdAt: true },
  });
  const latestDeliveryByRecipient = new Map(
    latestDeliveries.map((event) => [event.recipientId, event._max.createdAt]),
  );

  const due = candidates
    .filter((recipient) => {
      const deliveredAt = latestDeliveryByRecipient.get(recipient.id);
      return deliveredAt != null && deliveredAt <= cutoff;
    })
    .slice(0, MAX_REMINDERS_PER_RUN);

  let sent = 0;
  for (const recipient of due) {
    const claimedAt = new Date();
    const claimed = await prisma.signatureRecipient.updateMany({
      where: {
        id: recipient.id,
        remindedAt: null,
        status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
      },
      data: { remindedAt: claimedAt },
    });
    if (claimed.count !== 1) continue;

    try {
      const result = await notifyRecipient(recipient.id, { reminder: true });
      if (result.delivered) {
        sent += 1;
      } else {
        await prisma.signatureRecipient.updateMany({
          where: {
            id: recipient.id,
            remindedAt: claimedAt,
            status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
          },
          data: { remindedAt: null },
        });
      }
    } catch (error) {
      await prisma.signatureRecipient
        .updateMany({
          where: {
            id: recipient.id,
            remindedAt: claimedAt,
            status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
          },
          data: { remindedAt: null },
        })
        .catch(() => {});
      logError("signature-request-reminder", error);
    }
  }

  return sent;
}
