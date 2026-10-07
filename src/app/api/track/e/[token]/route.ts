import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { withTokenTenantScope } from "@/lib/tenantScopeEntry";
import { resolveEmailOpenTenant } from "@/lib/tokenTenant";
import { OPEN_TOKEN } from "@/lib/emailOpenTracking";

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * The open pixel in a one-to-one email (lib/emailOpenTracking.ts) — the sibling
 * of /api/track/o, which does the same for campaigns. Public (the customer's
 * mail app loads it), so it does nothing but answer with the pixel and, for a
 * real token, stamp the email's timeline entry: the first open sets seenAt,
 * every load counts. An unknown or malformed token gets the same pixel and
 * changes nothing, so it can't be used to probe which tokens exist.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (OPEN_TOKEN.test(token)) {
    await withTokenTenantScope(
      () => resolveEmailOpenTenant(token),
      async () => {
        const email = await prisma.communication.findUnique({ where: { openToken: token }, select: { id: true, seenAt: true } });
        if (!email) return;
        await prisma.communication.update({
          where: { id: email.id },
          data: { openCount: { increment: 1 }, seenAt: email.seenAt ?? new Date() },
        });
      },
      () => undefined,
    ).catch(() => {});
  }
  return new NextResponse(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
