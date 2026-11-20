import "server-only";
import { prisma } from "./db";
import { liveNotices, type NoticeRow } from "./signatureNotices";

/* The store behind dated signature lines (lib/signatureNotices.ts). Every query names the workspace. */

const SELECT = { id: true, userId: true, text: true, startsAt: true, endsAt: true, createdAt: true } as const;

/** The lines on this person's signature right now. [] on any failure: an email is never lost over a dated line. */
export async function liveNoticesFor(tenantId: string, userId: string, now = new Date()): Promise<string[]> {
  try {
    const rows = await prisma.signatureNotice.findMany({
      where: { tenantId, startsAt: { lte: now }, endsAt: { gt: now }, OR: [{ userId: null }, { userId }] },
      select: SELECT,
      take: 20,
    });
    return liveNotices(rows, userId, now);
  } catch {
    return [];
  }
}

/** The workspace's lines that are on now or still to come (ended ones are gone from view), soonest first. */
export async function upcomingNotices(tenantId: string, now = new Date()): Promise<NoticeRow[]> {
  return prisma.signatureNotice.findMany({
    where: { tenantId, endsAt: { gt: now } },
    select: SELECT,
    orderBy: [{ startsAt: "asc" }, { createdAt: "asc" }],
    take: 200,
  });
}
