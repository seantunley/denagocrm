import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveCampaignRecipientTenant } from "@/lib/tokenTenant";

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/** Open-tracking pixel: records that a campaign email was opened. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Phase C no-user edge: record the open inside the recipient's tenant scope
  // (dormant no-op when off). Best-effort — any error, or an unresolvable tenant
  // under enforcement, records nothing and still delivers the pixel.
  await withTokenTenantScope(
    () => resolveCampaignRecipientTenant(token),
    async () => {
      const r = await prisma.campaignRecipient.findUnique({ where: { token } });
      if (r) {
        const firstOpen = !r.openedAt;
        await prisma.campaignRecipient.update({
          where: { id: r.id },
          data: { openCount: { increment: 1 }, openedAt: r.openedAt ?? new Date() },
        });
        if (firstOpen) {
          await prisma.campaign.update({
            where: { id: r.campaignId },
            data: { openCount: { increment: 1 } },
          });
        }
      }
    },
    () => undefined,
  ).catch(() => {
    // never let tracking break image loading
  });
  return new NextResponse(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
