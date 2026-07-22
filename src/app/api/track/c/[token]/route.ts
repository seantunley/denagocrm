import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";
import { appBaseUrl } from "@/lib/campaigns";

/** Click-tracking redirect: records a click, then forwards to the real URL. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const target = req.nextUrl.searchParams.get("u") ?? "";
  const safe = /^https?:\/\//i.test(target) ? target : appBaseUrl();

  try {
    const r = await prisma.campaignRecipient.findUnique({ where: { token } });
    if (r) {
      // Phase C no-user edge: scope tracking writes to the recipient's tenant
      // (dormant no-op until enforcement). Errors stay swallowed — best-effort.
      establishTenantScopeFromId(r.tenantId);
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
  } catch {
    // fall through to redirect regardless
  }
  return NextResponse.redirect(safe, 302);
}
