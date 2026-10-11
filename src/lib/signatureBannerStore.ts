import "server-only";
import { prisma } from "./db";
import { ciExactIds } from "./ciExact";
import { contactName } from "./format";
import { sendPushToAll } from "./push";
import {
  BANNER_REF,
  CLICK_MAX_ANONYMOUS_PER_DAY,
  anonymousClickDay,
  bannerRecipients,
  clickDedupeCutoff,
  clickRetentionCutoff,
  emailClickAllowed,
  bannerClickUrl,
  bannerHtml,
  bannerPosition,
  chooseBanner,
  eligibleBanners,
  isBannerLink,
  placeBannerInEmail,
  type BannerPlace,
  type BannerRow,
} from "./signatureBanners";

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

/** The banners this person's emails could carry right now, the default first (lib/signatureBanners.ts → eligibleBanners). */
export async function bannersForSender(tenantId: string, senderId: string, place: BannerPlace = "composer"): Promise<BannerRow[]> {
  const banners = await prisma.signatureBanner.findMany({ where: { tenantId, active: true }, select: BANNER_SELECT });
  if (banners.length === 0) return [];
  // Team membership is only looked up when some banner is for a team.
  const teamIds = banners.some((banner) => banner.teamIds.length > 0) ? await senderTeamIds(tenantId, senderId) : [];
  return eligibleBanners(banners, { id: senderId, teamIds }, new Date(), place);
}

/**
 * The banner an email from `senderId` to `to` carries, or null.
 *
 * A banner is marketing, so the recipients' opt-out is checked HERE, at the one
 * door every sender goes through — by the record the email is filed on, and by
 * EVERY address it is going to, because the composer's "To" is free text and the
 * same person can be on file twice. An email to more people than can be checked
 * carries no banner at all: a partial check would be a guess about the rest.
 */
export async function bannerForEmail(input: {
  tenantId: string;
  senderId: string;
  place?: BannerPlace;
  /** The sender's pick in the composer: a banner id, NO_BANNER, or nothing for the default. */
  choice?: string | null;
  to?: string;
  contactId?: string | null;
  leadId?: string | null;
}): Promise<BannerRow | null> {
  const { tenantId } = input;
  const banner = chooseBanner(await bannersForSender(tenantId, input.senderId, input.place ?? "composer"), input.choice);
  if (!banner) return null;

  const addresses = bannerRecipients(input.to);
  if (addresses === null) return null;
  const lead = input.leadId ? await prisma.lead.findFirst({ where: { id: input.leadId, tenantId }, select: { contactId: true } }) : null;
  // Whoever is on file under an address typed in "To" — an exact, case-folded
  // match (lib/ciExact.ts), then read back through the guarded client below, so
  // a contact in another workspace can never decide anything here.
  const byAddress = (await Promise.all(addresses.map((address) => ciExactIds("contactEmail", address)))).flat();
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

export type BannerLink = { tenantId: string; bannerId: string; bannerName: string; destination: string };

/**
 * Where a banner link leads, from its token — the address frozen on the LINK
 * (SignatureBannerLink) when the email was sent, not whatever the banner points
 * at today. Reads only; null for an unknown token or an address that is no
 * longer a plain https link.
 */
export async function resolveBannerLink(token: string): Promise<BannerLink | null> {
  const link = await prisma.signatureBannerLink.findUnique({
    where: { token },
    select: { tenantId: true, bannerId: true, linkUrl: true, banner: { select: { name: true } } },
  });
  if (!link || !isBannerLink(link.linkUrl)) return null;
  return { tenantId: link.tenantId, bannerId: link.bannerId, bannerName: link.banner.name, destination: link.linkUrl };
}

/**
 * Record a click on a resolved link: count it, tie it to the email it came from
 * when that is known, mark that email's timeline entry and tell whoever sent it
 * (both once per email).
 *
 * Kept apart from resolveBannerLink on purpose, and run AFTER the customer has
 * been sent on (the route defers it): nothing here — a slow write, a stalled
 * push service, an error — can delay or lose the page they clicked for.
 */
export async function recordBannerClick(link: BannerLink, emailRef: string | null): Promise<void> {
  const { tenantId, bannerId } = link;
  const email =
    emailRef && BANNER_REF.test(emailRef)
      ? await prisma.communication.findFirst({
          where: { bannerRef: emailRef, tenantId },
          select: { id: true, userId: true, contactId: true, leadId: true, contact: true, lead: { select: { name: true } } },
        })
      : null;

  /*
   * IS THIS CLICK COUNTED? Decided by the database, one statement per gate, so
   * that two fetches of the same link arriving together cannot both pass (a mail
   * gateway scanning a link often fetches it twice). See the bounds in
   * lib/signatureBanners.ts. A click that is not counted writes NOTHING more.
   */
  const now = new Date();
  if (email) {
    const gate = await prisma.communication.updateMany({
      where: { id: email.id, tenantId, OR: [{ bannerLastClickAt: null }, { bannerLastClickAt: { lt: clickDedupeCutoff(now) } }] },
      data: { bannerLastClickAt: now },
    });
    if (gate.count !== 1) return;
    const counted = await prisma.signatureBannerClick.count({ where: { tenantId, bannerId, communicationId: email.id } });
    if (!emailClickAllowed(counted)) return;
  } else {
    const day = anonymousClickDay(now);
    // The first anonymous click of a new day resets the day's count; any other takes a place under the cap.
    const firstToday = await prisma.signatureBanner.updateMany({
      where: { id: bannerId, tenantId, OR: [{ anonymousDay: null }, { anonymousDay: { not: day } }] },
      data: { anonymousDay: day, anonymousClicks: 1 },
    });
    if (firstToday.count !== 1) {
      const underCap = await prisma.signatureBanner.updateMany({
        where: { id: bannerId, tenantId, anonymousDay: day, anonymousClicks: { lt: CLICK_MAX_ANONYMOUS_PER_DAY } },
        data: { anonymousClicks: { increment: 1 } },
      });
      if (underCap.count !== 1) return;
    }
  }

  await prisma.signatureBanner.updateMany({ where: { id: bannerId, tenantId }, data: { clickCount: { increment: 1 } } });
  await prisma.signatureBannerClick.create({ data: { tenantId, bannerId, communicationId: email?.id ?? null } });
  // Old click rows go as new ones arrive, so the table cannot grow without end. The totals on the banner stay.
  await prisma.signatureBannerClick.deleteMany({ where: { tenantId, bannerId, clickedAt: { lt: clickRetentionCutoff(now) } } }).catch(() => {});

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
        body: `${who} clicked “${link.bannerName}” in your email`,
        url: email.leadId ? `/leads/${email.leadId}` : email.contactId ? `/contacts/${email.contactId}` : "/settings/signature-banners",
      },
      "banner_click",
      { tenantId, userId: email.userId },
    ).catch(() => 0);
  }
}
