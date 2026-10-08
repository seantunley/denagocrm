import "server-only";

import { prisma } from "@/lib/db";
import { notifyRecipient } from "@/lib/signing/dispatch";
import type { ModuleSendOutcome } from "@/lib/journeyTypes";

/**
 * Automatic signing reminders are a JOURNEY ("Signing reminder", ready-made, off
 * until the owner switches it on in Journeys). This module only answers the two
 * questions the journey can't: who is due one, and how to send one safely — the
 * signer's own secret link, the editable reminder templates, the timeline record
 * with the link masked, and the once-per-signer claim all live here.
 *
 * The old `SIGNING_AUTO_REMINDERS` switch is read once, by the seeding
 * (readyMadeJourneys.ts), as the owner's prior approval. "Resend" by hand is
 * unaffected.
 */

const MAX_CANDIDATES_PER_RUN = 100;
const MAX_REMINDERS_PER_RUN = 25;
const LIVE_REQUEST_STATUSES = ["sent", "viewed", "in_progress"] as const;
const REMINDABLE_RECIPIENT_STATUSES = ["sent", "viewed"] as const;

export type SignerDue = {
  recipientId: string;
  requestId: string;
  /** The customer the journey run is about: the request's contact, else its quote's lead. */
  entityType: "contact" | "lead";
  entityId: string;
};

/**
 * Signers never reminded whose own latest delivery is at least `days` old, on a
 * request still open. Recipient delivery events are used instead of
 * SignatureRequest.sentAt so sequential signers get a full window after their
 * turn actually starts.
 *
 * A request with no customer record at all (no contact, quote or job card) can't
 * be enrolled in a journey, so it isn't returned.
 */
export async function signersAwaitingReminder(tenantId: string, days: number): Promise<SignerDue[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const candidates = await prisma.signatureRecipient.findMany({
    where: {
      tenantId,
      role: "signer",
      status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
      remindedAt: null,
      request: { is: { tenantId, deletedAt: null, status: { in: [...LIVE_REQUEST_STATUSES] } } },
    },
    select: { id: true, requestId: true },
    take: MAX_CANDIDATES_PER_RUN,
  });
  if (candidates.length === 0) return [];

  const latestDeliveries = await prisma.signatureEvent.groupBy({
    by: ["recipientId"],
    where: {
      tenantId,
      recipientId: { in: candidates.map((recipient) => recipient.id) },
      type: { in: ["sent", "delivered"] },
    },
    _max: { createdAt: true },
  });
  const latestDeliveryByRecipient = new Map(latestDeliveries.map((event) => [event.recipientId, event._max.createdAt]));
  const due = candidates
    .filter((recipient) => {
      const deliveredAt = latestDeliveryByRecipient.get(recipient.id);
      return deliveredAt != null && deliveredAt <= cutoff;
    })
    .slice(0, MAX_REMINDERS_PER_RUN);
  if (due.length === 0) return [];

  const requests = await prisma.signatureRequest.findMany({
    where: { tenantId, id: { in: [...new Set(due.map((r) => r.requestId))] } },
    select: { id: true, contactId: true, quoteId: true, jobCardId: true },
  });
  const quoteIds = requests.flatMap((r) => (r.quoteId ? [r.quoteId] : []));
  const jobCardIds = requests.flatMap((r) => (r.jobCardId ? [r.jobCardId] : []));
  const [quotes, jobCards] = await Promise.all([
    quoteIds.length ? prisma.quote.findMany({ where: { tenantId, id: { in: quoteIds } }, select: { id: true, contactId: true, leadId: true } }) : [],
    jobCardIds.length ? prisma.jobCard.findMany({ where: { tenantId, id: { in: jobCardIds } }, select: { id: true, contactId: true } }) : [],
  ]);
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const jobCardById = new Map(jobCards.map((j) => [j.id, j]));
  const customerOf = new Map(
    requests.map((r) => {
      const quote = r.quoteId ? quoteById.get(r.quoteId) : undefined;
      const contactId = r.contactId ?? quote?.contactId ?? (r.jobCardId ? jobCardById.get(r.jobCardId)?.contactId : null) ?? null;
      const customer = contactId
        ? { entityType: "contact" as const, entityId: contactId }
        : quote?.leadId
          ? { entityType: "lead" as const, entityId: quote.leadId }
          : null;
      return [r.id, customer];
    }),
  );
  return due.flatMap((recipient) => {
    const customer = customerOf.get(recipient.requestId);
    return customer ? [{ recipientId: recipient.id, requestId: recipient.requestId, ...customer }] : [];
  });
}

/**
 * Send ONE automatic reminder to one signer — the journey step's sender.
 *
 * The claim on `remindedAt` is what makes it once per signer, ever, however many
 * runs or retries reach it: only a signer still unsigned on a live request, and
 * never reminded, is claimed. If no channel accepted the reminder the claim is
 * released, so a retry may try again.
 */
export async function remindSigner(recipientId: string, tenantId: string): Promise<ModuleSendOutcome> {
  const claimedAt = new Date();
  const claimed = await prisma.signatureRecipient.updateMany({
    where: {
      id: recipientId,
      tenantId,
      role: "signer",
      remindedAt: null,
      status: { in: [...REMINDABLE_RECIPIENT_STATUSES] },
      request: { is: { tenantId, deletedAt: null, status: { in: [...LIVE_REQUEST_STATUSES] } } },
    },
    data: { remindedAt: claimedAt },
  });
  if (claimed.count !== 1) {
    return { kind: "skipped", reason: "already reminded, already signed, or the request is closed" };
  }

  const release = () =>
    prisma.signatureRecipient
      .updateMany({
        where: { id: recipientId, tenantId, remindedAt: claimedAt, status: { in: [...REMINDABLE_RECIPIENT_STATUSES] } },
        data: { remindedAt: null },
      })
      .catch(() => {});
  try {
    const result = await notifyRecipient(recipientId, { reminder: true });
    if (result.delivered) return { kind: "sent" };
    await release();
    return result.reachable
      ? { kind: "failed", reason: "no channel accepted the reminder" }
      : { kind: "skipped", reason: "the signer has no email address or WhatsApp number" };
  } catch (error) {
    await release();
    throw error;
  }
}
