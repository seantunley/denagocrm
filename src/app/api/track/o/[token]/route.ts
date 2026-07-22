import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { establishTenantScopeFromId } from "@/lib/tenantScopeEntry";

// 1x1 transparent GIF
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

/** Open-tracking pixel: records that a campaign email was opened. */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const r = await prisma.campaignRecipient.findUnique({ where: { token } });
    if (r) {
      // Phase C no-user edge: scope tracking writes to the recipient's tenant
      // (dormant no-op until enforcement). Errors stay swallowed by the catch —
      // tracking is best-effort and must never break pixel delivery.
      establishTenantScopeFromId(r.tenantId);
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
  } catch {
    // never let tracking break image loading
  }
  return new NextResponse(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
