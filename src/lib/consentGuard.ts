import "server-only";
import { prisma } from "./db";

export type ContactChannel = "email" | "sms" | "whatsapp";
export type ContactPurpose = "marketing" | "service" | "transactional";

/**
 * The single source of truth for "may we contact this person, on this channel,
 * for this purpose?". Every outbound marketing path should route through here so
 * consent is enforced consistently.
 *
 * - transactional / service messages are always allowed (they are not marketing)
 * - marketing requires: no `Contact.marketingOptOut`, AND no marketing opt-out in
 *   the portal preferences. The portal has two overlapping marketing flags
 *   (`marketingEmail` and the newer `emailMarketing`); the person is treated as
 *   opted OUT if EITHER is explicitly false, until the fields are consolidated.
 */
export async function canContactPerson(input: {
  contactId: string;
  channel: ContactChannel;
  purpose: ContactPurpose;
}): Promise<boolean> {
  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: { marketingOptOut: true },
  });
  if (!contact) return false; // unknown or soft-deleted
  if (input.purpose !== "marketing") return true;
  if (contact.marketingOptOut) return false;

  const pref = await prisma.portalPreference.findUnique({ where: { contactId: input.contactId } });
  return marketingAllowed({ marketingOptOut: contact.marketingOptOut, channel: input.channel, pref });
}

/**
 * Synchronous marketing check for callers that already hold the flags (avoids a
 * re-fetch inside tight loops — e.g. campaign/journey batches). Mirrors the
 * marketing branch of canContactPerson exactly.
 */
export function marketingAllowed(flags: {
  marketingOptOut?: boolean | null;
  channel?: ContactChannel;
  pref?: { marketingEmail?: boolean | null; emailMarketing?: boolean | null } | null;
}): boolean {
  if (flags.marketingOptOut) return false;
  const p = flags.pref;
  if (p && (flags.channel ?? "email") === "email" && (p.marketingEmail === false || p.emailMarketing === false)) {
    return false;
  }
  return true;
}
