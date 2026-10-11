import "server-only";
import { prisma } from "./db";
import { ciExactIds } from "./ciExact";
import { contactName } from "./format";
import { OPEN_TOKEN } from "./emailOpenTracking";
import { sendPushToAll } from "./push";
import { bannerClickUrl, bannerHtml, bannerPosition, isBannerLink, pickBanner, placeBannerInEmail, type BannerPlace, type BannerRow } from "./signatureBanners";

/** What the rules (signatureBanners.ts) need of a banner — the one select for every reader. */
export const BANNER_SELECT = {
  id: true, name: true, imageUrl: true, width: true, height: true, linkUrl: true, altText: true, active: true, startsAt: true,
  endsAt: true, senderIds: true, teamIds: true, position: true, onQuoteEmails: true, token: true, createdAt: true,
} as const;

/** The teams a person is in, in this workspace — a banner can be for a team. */
export async function senderTeamIds(tenantId: string, userId: string): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({ where: { tenantId, userId, team: { active: true, deletedAt: null } }, select: { teamId: true } });
  return rows.map((row) => row.teamId);
}

/**
 * The banner an email from `senderId` to `to` carries, or null.
 *
 * A banner is marketing, so the recipient's opt-out is checked HERE, at the one
 * door every sender goes through — by the record the email is filed on, and by
 * the address itself, because the composer's "To" is free text and the same
 * person can be on file twice.
 */
export async function bannerForEmail(input: {
  tenantId: string;
  senderId: string;
  place?: BannerPlace;
  to?: string;
  contactId?: string | null;
  leadId?: string | null;
}): Promise<BannerRow | null> {
  const { tenantId } = input;
  const banners = await prisma.signatureBanner.findMany({ where: { tenantId, active: true }, select: BANNER_SELECT });
  if (banners.length === 0) return null;
  // Team membership is only looked up when some banner is for a team.
  const teamIds = banners.some((banner) => banner.teamIds.length > 0) ? await senderTeamIds(tenantId, input.senderId) : [];
  const banner = pickBanner(banners, { id: input.senderId, teamIds }, new Date(), input.place ?? "composer");
  if (!banner) return null;

  const addresses = (input.to ?? "").split(/[,;]/).map((address) => address.trim()).filter(Boolean);
  const lead = input.leadId ? await prisma.lead.findFirst({ where: { id: input.leadId, tenantId }, select: { contactId: true } }) : null;
  // Whoever is on file under an address typed in "To" — an exact, case-folded
  // match (lib/ciExact.ts), then read back through the guarded client below, so
  // a contact in another workspace can never decide anything here.
  const byAddress = (await Promise.all(addresses.slice(0, 20).map((address) => ciExactIds("contactEmail", address)))).flat();
  const contactIds = [input.contactId, lead?.contactId, ...byAddress].filter((id): id is string => Boolean(id));
  if (contactIds.length === 0) return banner;
  const optedOut = await prisma.contact.findFirst({
    where: { tenantId, marketingOptOut: true, id: { in: contactIds } },
    select: { id: true },
  });
  return optedOut ? null : banner;
}

/**
 * A finished email (a quote a person is emailing) with the live banner put in,
 * if there is one for this sender and this customer. Never a reason to lose the
 * email: anything that goes wrong returns it as it came.
 */
export async function emailWithBanner(input: {
  html: string;
  origin: string;
  tenantId: string | null;
  senderId: string;
  place: BannerPlace;
  to?: string;
  contactId?: string | null;
  leadId?: string | null;
}): Promise<{ html: string; bannerId: string | null }> {
  const { html, tenantId } = input;
  if (!tenantId) return { html, bannerId: null };
  const banner = await bannerForEmail({ ...input, tenantId }).catch(() => null);
  if (!banner) return { html, bannerId: null };
  return { html: placeBannerInEmail(html, bannerHtml(banner, bannerClickUrl(input.origin, banner.token)), bannerPosition(banner.position)), bannerId: banner.id };
}

/** One more email went out carrying this banner. Never a reason to fail a send. */
export async function recordBannerSent(tenantId: string, bannerId: string): Promise<void> {
  await prisma.signatureBanner.updateMany({ where: { id: bannerId, tenantId }, data: { sentCount: { increment: 1 } } }).catch(() => {});
}

/**
 * A click on a banner's link: count it, tie it to the email it came from when
 * that is known, mark that email's timeline entry and tell whoever sent it (both
 * once per email), and answer with where to send the customer — the banner's own
 * stored address, never anything from the request. Null for a token that matches
 * no banner.
 */
export async function recordBannerClick(token: string, emailRef: string | null): Promise<string | null> {
  const banner = await prisma.signatureBanner.findUnique({ where: { token }, select: { id: true, tenantId: true, name: true, linkUrl: true } });
  if (!banner || !isBannerLink(banner.linkUrl)) return null;
  const { tenantId } = banner;

  const email =
    emailRef && OPEN_TOKEN.test(emailRef)
      ? await prisma.communication.findFirst({
          where: { openToken: emailRef, tenantId },
          select: { id: true, userId: true, contactId: true, leadId: true, contact: true, lead: { select: { name: true } } },
        })
      : null;

  await prisma.signatureBanner.updateMany({ where: { id: banner.id, tenantId }, data: { clickCount: { increment: 1 } } });
  await prisma.signatureBannerClick.create({ data: { tenantId, bannerId: banner.id, communicationId: email?.id ?? null } });

  // "First click" is decided by the database, in one statement: of two clicks
  // arriving together only one finds the stamp empty, so the sender is told once.
  const first = email
    ? (await prisma.communication.updateMany({ where: { id: email.id, tenantId, bannerClickedAt: null }, data: { bannerClickedAt: new Date() } })).count === 1
    : false;
  // The salesperson's cue to pick up the phone. A customer who clicks three
  // times is one piece of news, not three.
  if (email?.userId && first) {
    const who = email.contact ? contactName(email.contact) : email.lead?.name || "A customer";
    await sendPushToAll(
      {
        title: "Banner clicked",
        body: `${who} clicked “${banner.name}” in your email`,
        url: email.leadId ? `/leads/${email.leadId}` : email.contactId ? `/contacts/${email.contactId}` : "/settings/signature-banners",
      },
      "banner_click",
      { tenantId, userId: email.userId },
    ).catch(() => 0);
  }
  return banner.linkUrl;
}
