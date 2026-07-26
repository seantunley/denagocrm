import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/campaigns";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "campaign";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = req.nextUrl.searchParams.get("u") ?? "";
  let redirectUrl = /^https?:\/\//i.test(target) ? target : appBaseUrl();

  await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => {
      const recipient = await prisma.campaignRecipient.findUnique({ where: { token } });
      if (!recipient) return;
      const campaigns = await basePrisma.$queryRaw<Array<{
        id: string; tenantId: string | null; name: string; channel: string;
        utmSource: string | null; utmMedium: string | null; utmCampaign: string | null;
        utmContent: string | null; utmTerm: string | null;
      }>>`
        SELECT "id", "tenantId", "name", "channel", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"
        FROM "Campaign" WHERE "id" = ${recipient.campaignId} LIMIT 1
      `;
      const campaign = campaigns[0];
      if (!campaign) return;

      try {
        const url = new URL(redirectUrl);
        const defaults: Record<string, string | null> = {
          utm_source: campaign.utmSource || "denagocrm",
          utm_medium: campaign.utmMedium || campaign.channel,
          utm_campaign: campaign.utmCampaign || slug(campaign.name),
          utm_content: campaign.utmContent,
          utm_term: campaign.utmTerm,
        };
        for (const [key, value] of Object.entries(defaults)) if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
        redirectUrl = url.toString();
      } catch {
        redirectUrl = appBaseUrl();
      }

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
