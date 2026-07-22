import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { appBaseUrl } from "@/lib/campaigns";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";

/** Click-tracking redirect: records a click, then forwards to the real URL. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = req.nextUrl.searchParams.get("u") ?? "";
  const safe = /^https?:\/\//i.test(target) ? target : appBaseUrl();

  // Phase C no-user edge: record the click inside the recipient's tenant scope
  // (dormant no-op when off). Best-effort — always forwards to the target.
  await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => {
      const r = await prisma.campaignRecipient.findUnique({ where: { token } });
      if (r) {
        const firstClick = !r.clickedAt;
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: {
            clickCount: { increment: 1 },
            clickedAt: r.clickedAt ?? new Date(),
            openedAt: r.openedAt ?? new Date(), // a click implies an open
          },
        });
        if (firstClick) {
          await prisma.campaign.update({
            where: { id: r.campaignId },
            data: { clickCount: { increment: 1 } },
          });
        }
      }
    },
    () => undefined,
  ).catch(() => {
    // fall through to redirect regardless
  });
  return NextResponse.redirect(safe, 302);
}
