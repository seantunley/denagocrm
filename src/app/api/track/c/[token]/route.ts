import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/campaigns";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";
import { campaignLinkHosts, configuredRedirectHosts, safeRedirectTarget } from "@/lib/trackRedirect";

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "campaign";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = req.nextUrl.searchParams.get("u");
  // FAIL CLOSED. `?u=` is attacker-controlled, so the destination starts as the
  // app's own home page and is only ever upgraded from inside the token-scoped
  // block below — after the token has resolved to a real recipient AND campaign,
  // and only to a host that campaign vouches for. An unknown token, an
  // unvouched destination or a database failure therefore all land on home,
  // never on whatever the query string asked for. Home rather than a 404
  // because that is what this surface already does for a missing/unparseable
  // `u`, and what the sibling token routes do for a token they cannot honour:
  // the open pixel still returns its pixel and unsubscribe still renders a
  // neutral page. A real recipient clicking a link from a purged campaign
  // should reach the company's site, not an error.
  let redirectUrl = appBaseUrl();

  await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => {
      const recipient = await prisma.campaignRecipient.findUnique({ where: { token } });
      if (!recipient) return;
      const campaigns = await basePrisma.$queryRaw<Array<{
        id: string; tenantId: string | null; name: string; channel: string; body: string; htmlBody: string | null;
        utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
        utmContent: string | null; utmTerm: string | null;
      }>>`
        SELECT "id", "tenantId", "name", "channel", "body", "htmlBody", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"
        FROM "Campaign" WHERE "id" = ${recipient.campaignId} LIMIT 1
      `;
      const campaign = campaigns[0];
      if (!campaign) return;

      // The destination must be one THIS campaign's own stored body links to
      // (plus the app itself and any operator-configured hosts). `?u=` can then
      // only re-point a click within the set of hosts the campaign already sent
      // people to — it can no longer nominate a destination of its own.
      const destination = safeRedirectTarget(target, [
        appBaseUrl(),
        ...configuredRedirectHosts(),
        ...campaignLinkHosts(campaign.htmlBody ?? campaign.body),
      ]);
      // Not a link this campaign sent: stay on home, and record nothing. A
      // forged destination is not a click on our campaign, and letting it
      // through would also inflate the campaign's click stats and write an
      // attacker-chosen string into MarketingTouch.targetUrl.
      if (!destination) return;

      const url = new URL(destination);
      const defaults: Record<string, string | null> = {
        utm_source: campaign.utmSource || "denagocrm",
        utm_medium: campaign.utmMedium || campaign.channel,
        utm_campaign: campaign.utmCampaign || slug(campaign.name),
        utm_content: campaign.utmContent,
        utm_term: campaign.utmTerm,
      };
      for (const [key, value] of Object.entries(defaults)) if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
      redirectUrl = url.toString();

      const firstClick = !recipient.clickedAt;
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { clickCount: { increment: 1 }, clickedAt: recipient.clickedAt ?? new Date(), openedAt: recipient.openedAt ?? new Date() },
      });
      if (firstClick) await prisma.campaign.update({ where: { id: recipient.campaignId }, data: { clickCount: { increment: 1 } } });

      const bucket = Math.floor(Date.now() / 300_000);
      const targetHash = crypto.createHash("sha256").update(redirectUrl).digest("hex").slice(0, 20);
      await basePrisma.$executeRaw`
        INSERT INTO "MarketingTouch" (
          "id", "tenantId", "campaignId", "campaignRecipientId", "contactId", "type", "targetUrl",
          "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "eventKey", "metadata", "occurredAt"
        ) VALUES (
          ${`mt_${crypto.randomUUID()}`}, ${campaign.tenantId}, ${campaign.id}, ${recipient.id}, ${recipient.contactId}, 'click', ${redirectUrl},
          ${campaign.utmSource || "denagocrm"}, ${campaign.utmMedium || campaign.channel}, ${campaign.utmCampaign || slug(campaign.name)},
          ${campaign.utmContent}, ${campaign.utmTerm}, ${`click:${recipient.id}:${targetHash}:${bucket}`},
          ${JSON.stringify({ userAgent: req.headers.get("user-agent"), referer: req.headers.get("referer") })}::jsonb, CURRENT_TIMESTAMP
        ) ON CONFLICT ("eventKey") DO NOTHING
      `;
    },
    () => undefined,
  ).catch(() => {});

  return NextResponse.redirect(redirectUrl, 302);
}
