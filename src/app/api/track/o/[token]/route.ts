import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma, basePrisma } from "@/lib/db";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";

const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => {
      const recipient = await prisma.campaignRecipient.findUnique({ where: { token } });
      if (!recipient) return;
      const firstOpen = !recipient.openedAt;
      await prisma.campaignRecipient.update({
        where: { id: recipient.id },
        data: { openCount: { increment: 1 }, openedAt: recipient.openedAt ?? new Date() },
      });
      if (firstOpen) {
        await prisma.campaign.update({ where: { id: recipient.campaignId }, data: { openCount: { increment: 1 } } });
        const campaigns = await basePrisma.$queryRaw<Array<{
          tenantId: string | null; name: string; channel: string; utmSource: string | null;
          utmMedium: string | null; utmCampaign: string | null; utmContent: string | null; utmTerm: string | null;
        }>>`
          SELECT "tenantId", "name", "channel", "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm"
          FROM "Campaign" WHERE "id" = ${recipient.campaignId} LIMIT 1
        `;
        const campaign = campaigns[0];
        if (campaign) {
          await basePrisma.$executeRaw`
            INSERT INTO "MarketingTouch" (
              "id", "tenantId", "campaignId", "campaignRecipientId", "contactId", "type",
              "utmSource", "utmMedium", "utmCampaign", "utmContent", "utmTerm", "eventKey", "metadata", "occurredAt"
            ) VALUES (
              ${`mt_${crypto.randomUUID()}`}, ${campaign.tenantId}, ${recipient.campaignId}, ${recipient.id}, ${recipient.contactId}, 'open',
              ${campaign.utmSource || "denagocrm"}, ${campaign.utmMedium || campaign.channel}, ${campaign.utmCampaign || campaign.name},
              ${campaign.utmContent}, ${campaign.utmTerm}, ${`open:${recipient.id}`}, '{}'::jsonb, CURRENT_TIMESTAMP
            ) ON CONFLICT ("eventKey") DO NOTHING
          `;
        }
      }
    },
    () => undefined,
  ).catch(() => {});
  return new NextResponse(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
