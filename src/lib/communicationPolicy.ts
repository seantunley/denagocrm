import { basePrisma } from "./db";

export type CommunicationPurpose = "marketing" | "transactional" | "service" | "survey_marketing" | "survey_transactional";
export type CommunicationChannel = "email" | "sms" | "whatsapp";
export type EligibilityResult = { allowed: boolean; channel?: CommunicationChannel; destination?: string; reason?: string };

type ContactPolicyRow = {
  id: string;
  tenantId: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  marketingOptOut: boolean;
  deletedAt: Date | null;
};

function destination(contact: ContactPolicyRow, channel: CommunicationChannel) {
  if (channel === "email") return contact.email?.trim() || null;
  if (channel === "whatsapp") return contact.whatsapp?.trim() || contact.phone?.trim() || null;
  return contact.phone?.trim() || contact.whatsapp?.trim() || null;
}

export function isCommunicationQuietHour(now: Date, timeZone = "Africa/Johannesburg") {
  const hour = Number(new Intl.DateTimeFormat("en-ZA", { hour: "2-digit", hour12: false, timeZone }).format(now));
  return hour >= 20 || hour < 8;
}

export function nextCommunicationWindow(now: Date, timeZone = "Africa/Johannesburg") {
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);
  while (isCommunicationQuietHour(candidate, timeZone)) {
    candidate.setMinutes(candidate.getMinutes() + 15);
  }
  return candidate;
}

export function classifyRetry(attemptCount: number, maxAttempts = 3) {
  return attemptCount < maxAttempts ? "failed_temporary" : "failed_permanent";
}

export async function canContactPerson(args: {
  contactId: string;
  tenantId: string | null;
  purpose: CommunicationPurpose;
  requestedChannel: CommunicationChannel;
  campaignId?: string;
  campaignRecipientId?: string;
  distributionId?: string;
  now?: Date;
}): Promise<EligibilityResult> {
  const now = args.now ?? new Date();
  const rows = await basePrisma.$queryRaw<ContactPolicyRow[]>`
    SELECT "id", "tenantId", "email", "phone", "whatsapp", "marketingOptOut", "deletedAt"
    FROM "Contact"
    WHERE "id" = ${args.contactId} AND "tenantId" IS NOT DISTINCT FROM ${args.tenantId}
    LIMIT 1
  `;
  const contact = rows[0];
  if (!contact) return { allowed: false, reason: "contact_not_found_or_cross_tenant" };
  if (contact.deletedAt) return { allowed: false, reason: "contact_deleted" };
  const requestedDestination = destination(contact, args.requestedChannel);
  if (!requestedDestination) return { allowed: false, reason: `missing_${args.requestedChannel}_destination` };

  const marketing = args.purpose === "marketing" || args.purpose === "survey_marketing";
  if (marketing && contact.marketingOptOut) return { allowed: false, reason: "marketing_opt_out" };

  if (marketing) {
    const consent = await basePrisma.consentRecord.findFirst({
      where: { contactId: contact.id, tenantId: args.tenantId, type: "marketing" },
      orderBy: { createdAt: "desc" },
      select: { granted: true },
    });
    if (consent && !consent.granted) return { allowed: false, reason: "consent_withdrawn" };

    // The customer's OWN switch, in the portal. This lived in a second gate
    // (consentGuard) that campaigns and surveys never called, so someone who
    // unsubscribed in the portal was suppressed on journeys and still received
    // campaign and survey mail — the "I unsubscribed and you keep emailing me"
    // complaint. The portal has two overlapping marketing flags; the person is
    // opted OUT if EITHER is explicitly false, until they are consolidated.
    if (args.requestedChannel === "email") {
      const pref = await basePrisma.portalPreference.findFirst({
        where: { contactId: contact.id },
        select: { marketingEmail: true, emailMarketing: true },
      });
      if (pref && (pref.marketingEmail === false || pref.emailMarketing === false)) {
        return { allowed: false, reason: "portal_unsubscribed" };
      }
    }

    if (isCommunicationQuietHour(now)) return { allowed: false, reason: "quiet_hours" };
  }

  if (args.campaignId) {
    const deliveredDuplicate = await basePrisma.campaignRecipient.findFirst({
      where: {
        campaignId: args.campaignId,
        contactId: contact.id,
        tenantId: args.tenantId,
        ...(args.campaignRecipientId ? { id: { not: args.campaignRecipientId } } : {}),
        status: { in: ["sent", "delivered"] },
      },
      select: { id: true },
    });
    if (deliveredDuplicate) return { allowed: false, reason: "duplicate_delivery" };

    if (args.campaignRecipientId) {
      const winner = await basePrisma.campaignRecipient.findFirst({
        where: {
          campaignId: args.campaignId,
          contactId: contact.id,
          tenantId: args.tenantId,
          status: "sending",
        },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      if (winner && winner.id !== args.campaignRecipientId) return { allowed: false, reason: "duplicate_delivery" };
    }
  }

  const recent = await basePrisma.communication.count({
    where: {
      contactId: contact.id,
      tenantId: args.tenantId,
      direction: "outbound",
      createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
      type: args.requestedChannel === "email" ? "email" : "sms",
    },
  });
  if (marketing && recent >= 3) return { allowed: false, reason: "frequency_cap" };

  return { allowed: true, channel: args.requestedChannel, destination: requestedDestination };
}
