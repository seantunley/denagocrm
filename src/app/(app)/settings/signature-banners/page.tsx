import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { contactName, formatDate, formatDateTime } from "@/lib/format";
import { listActingTenantStaff, listActingTenantTeams } from "@/lib/tenantActor";
import { bannerDayValue, bannerPosition, bannerState, pickBanner } from "@/lib/signatureBanners";
import { BANNER_SELECT, senderTeamIds } from "@/lib/signatureBannerStore";
import { SettingsWorkspace } from "@/components/settings-workspace";
import { SETTINGS_NAV_GROUPS } from "@/lib/settings-navigation";
import SignatureBanners, { type BannerView, type ClickView } from "@/components/settings/SignatureBanners";

export const dynamic = "force-dynamic";

/**
 * Marketing banners under the email signature (lib/signatureBanners.ts).
 *
 * `requireTenantOwner` here as well as in the actions: the actions protect the
 * writes; this stops a member being shown a page whose every control would
 * refuse them. Every read names the workspace — the owner check says who is
 * asking, not whose rows these are.
 */
export default async function SignatureBannersPage() {
  const user = await requireTenantOwner();
  const tenantId = await getActiveTenantId();
  const now = new Date();
  const [rows, staff, teams, myTeamIds, clickRows] = tenantId
    ? await Promise.all([
        prisma.signatureBanner.findMany({
          where: { tenantId },
          select: { ...BANNER_SELECT, sentCount: true, clickCount: true },
          orderBy: { createdAt: "desc" },
        }),
        listActingTenantStaff(),
        listActingTenantTeams(),
        senderTeamIds(tenantId, user.id),
        prisma.signatureBannerClick.findMany({
          where: { tenantId },
          orderBy: { clickedAt: "desc" },
          take: 15,
          select: { id: true, clickedAt: true, communicationId: true, banner: { select: { name: true } } },
        }),
      ])
    : [[], [], [], [], []];

  const emailIds = clickRows.flatMap((click) => (click.communicationId ? [click.communicationId] : []));
  const emails = emailIds.length && tenantId
    ? await prisma.communication.findMany({
        where: { id: { in: emailIds }, tenantId },
        select: { id: true, contactId: true, leadId: true, contact: true, lead: { select: { name: true } } },
      })
    : [];
  const emailById = new Map(emails.map((email) => [email.id, email]));

  const banners: BannerView[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    imageUrl: row.imageUrl,
    width: row.width,
    height: row.height,
    linkUrl: row.linkUrl,
    altText: row.altText,
    active: row.active,
    startsOn: bannerDayValue(row.startsAt),
    endsOn: bannerDayValue(row.endsAt),
    startsLabel: row.startsAt ? formatDate(row.startsAt) : "",
    endsLabel: row.endsAt ? formatDate(row.endsAt) : "",
    senderIds: row.senderIds,
    teamIds: row.teamIds,
    position: bannerPosition(row.position),
    onQuoteEmails: row.onQuoteEmails,
    sentCount: row.sentCount,
    clickCount: row.clickCount,
    state: bannerState(row, now),
  }));
  const clicks: ClickView[] = clickRows.map((click) => {
    const email = click.communicationId ? emailById.get(click.communicationId) : undefined;
    return {
      id: click.id,
      banner: click.banner.name,
      who: email?.contact ? contactName(email.contact) : email?.lead?.name || "Someone (the email was not tracked)",
      href: email?.leadId ? `/leads/${email.leadId}` : email?.contactId ? `/contacts/${email.contactId}` : null,
      when: formatDateTime(click.clickedAt),
    };
  });

  return (
    <SettingsWorkspace
      current="signature-banners"
      title="Signature banners"
      description="Put a marketing banner under your team's email signature, run a promotion over it for a while, and see who clicks."
      groups={SETTINGS_NAV_GROUPS}
    >
      <SignatureBanners
        banners={banners}
        staff={staff.map(({ id, name }) => ({ id, name }))}
        teams={teams.map(({ id, name }) => ({ id, name }))}
        clicks={clicks}
        showingNowId={pickBanner(rows, { id: user.id, teamIds: myTeamIds }, now)?.id ?? null}
      />
    </SettingsWorkspace>
  );
}
