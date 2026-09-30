import { basePrisma } from "./db";

/**
 * "service" = service reminders, recall notices, anything about the customer's
 * own vehicle that they did not just ask for. "review" = a review request: it is
 * solicitation, so it honours every marketing opt-out, but it is a one-off tied
 * to a delivery or job card, so quiet hours and the frequency cap do not apply.
 */
export type CommunicationPurpose = "marketing" | "transactional" | "service" | "review" | "survey_marketing" | "survey_transactional";
export type CommunicationChannel = "email" | "sms" | "whatsapp";
export type EligibilityResult = { allowed: boolean; channel?: CommunicationChannel; destination?: string; reason?: string };

type PortalPrefRow = {
  serviceReminders: boolean;
  emailServiceUpdates: boolean;
  smsServiceUpdates: boolean;
  marketingEmail: boolean;
  emailMarketing: boolean;
};

/**
 * The customer's OWN switches, in the portal. Pure, so it is unit-tested.
 *
 * The portal has overlapping flags written by two forms (portal.ts writes the
 * emailServiceUpdates/smsServiceUpdates/emailMarketing set, portalExpansion.ts
 * writes both sets), so a person is opted
 * OUT if EITHER of a pair is explicitly false. There is only one non-email
 * switch ("SMS service updates"); WhatsApp is held to it too.
 */
export function portalPreferenceBlock(
  pref: PortalPrefRow | null,
  purpose: CommunicationPurpose,
  channel: CommunicationChannel,
): string | null {
  if (!pref) return null;
  const marketingLike = purpose === "marketing" || purpose === "survey_marketing" || purpose === "review";
  if (marketingLike && channel === "email" && (pref.marketingEmail === false || pref.emailMarketing === false)) {
    return "portal_unsubscribed";
  }
  if (purpose === "service") {
    if (channel === "email" && (pref.serviceReminders === false || pref.emailServiceUpdates === false)) {
      return "portal_service_opt_out";
    }
    if (channel !== "email" && pref.smsServiceUpdates === false) return "portal_service_opt_out";
  }
  return null;
}

const REASON_LABELS: Record<string, string> = {
  contact_not_found_or_cross_tenant: "contact not found",
  contact_deleted: "contact is in Trash",
  missing_email_destination: "no email address on file",
  missing_sms_destination: "no phone number on file",
  missing_whatsapp_destination: "no WhatsApp number on file",
  marketing_opt_out: "customer opted out of marketing",
  consent_withdrawn: "consent withdrawn",
  portal_unsubscribed: "customer unsubscribed in the portal",
  portal_service_opt_out: "customer turned these messages off in the portal",
  quiet_hours: "quiet hours",
  frequency_cap: "frequency cap",
  duplicate_delivery: "already delivered",
};

/** Plain words for a refusal, for audit lines and staff-facing errors. */
export function describeBlockedReason(reason: string | undefined): string {
  if (!reason) return "not contactable";
  return reason
    .split(", ")
    .map((part) => REASON_LABELS[part.replace(/^\w+: /, "")] ?? part)
    .filter((label, i, all) => all.indexOf(label) === i)
    .join("; ");
}

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
  const honoursMarketingOptOut = marketing || args.purpose === "review";
  const service = args.purpose === "service";
  if (honoursMarketingOptOut && contact.marketingOptOut) return { allowed: false, reason: "marketing_opt_out" };

  if (honoursMarketingOptOut || service) {
    const consent = await basePrisma.consentRecord.findFirst({
      where: { contactId: contact.id, tenantId: args.tenantId, type: service ? "service" : "marketing" },
      orderBy: { createdAt: "desc" },
      select: { granted: true },
    });
    if (consent && !consent.granted) return { allowed: false, reason: "consent_withdrawn" };

    // The customer's OWN switches, in the portal. The marketing one lived in a
    // second gate (consentGuard) that campaigns and surveys never called; the
    // service ones ("Email service reminders", "SMS service updates") were
    // written by the portal and read by nothing, so a customer who switched
    // reminders off kept getting them.
    const pref = await basePrisma.portalPreference.findFirst({
      where: { contactId: contact.id },
      select: { serviceReminders: true, emailServiceUpdates: true, smsServiceUpdates: true, marketingEmail: true, emailMarketing: true },
    });
    const portalBlock = portalPreferenceBlock(pref, args.purpose, args.requestedChannel);
    if (portalBlock) return { allowed: false, reason: portalBlock };

    if (marketing && isCommunicationQuietHour(now)) return { allowed: false, reason: "quiet_hours" };
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

  if (marketing) {
    const recent = await basePrisma.communication.count({
      where: {
        contactId: contact.id,
        tenantId: args.tenantId,
        direction: "outbound",
        createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        type: args.requestedChannel === "email" ? "email" : "sms",
      },
    });
    if (recent >= 3) return { allowed: false, reason: "frequency_cap" };
  }

  return { allowed: true, channel: args.requestedChannel, destination: requestedDestination };
}

/**
 * The first of `channels` (in order) this person may be reached on. When none
 * is allowed, `reason` names each channel's refusal ("email: x, sms: y").
 */
export async function firstAllowedChannel(
  args: Omit<Parameters<typeof canContactPerson>[0], "requestedChannel"> & { channels: CommunicationChannel[] },
): Promise<EligibilityResult> {
  const reasons: string[] = [];
  for (const requestedChannel of args.channels) {
    const verdict = await canContactPerson({ ...args, requestedChannel });
    if (verdict.allowed) return verdict;
    reasons.push(`${requestedChannel}: ${verdict.reason ?? "not contactable"}`);
  }
  return { allowed: false, reason: reasons.join(", ") };
}
