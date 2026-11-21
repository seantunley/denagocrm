import "server-only";
import { prisma } from "./db";
import { liveNotices, NOTICES_SHOWN, type NoticeRow } from "./signatureNotices";

/* The store behind dated signature lines (lib/signatureNotices.ts). Every query names the workspace. */

const SELECT = { id: true, userId: true, text: true, startsAt: true, endsAt: true, createdAt: true } as const;

/** The lines on this person's signature right now. [] on any failure: an email is never lost over a dated line. */
export async function liveNoticesFor(tenantId: string, userId: string, now = new Date()): Promise<string[]> {
  try {
    // The person's own lines and the workspace's, read SEPARATELY and in liveNotices' own order before the limit:
    // one query with a limit could fill up with workspace lines and drop someone's "On leave until…" (review of #1166).
    const live = (who: string | null) =>
      prisma.signatureNotice.findMany({
        where: { tenantId, userId: who, startsAt: { lte: now }, endsAt: { gt: now } },
        select: SELECT,
        orderBy: [{ endsAt: "asc" }, { createdAt: "asc" }],
        take: NOTICES_SHOWN,
      });
    const [own, everyone] = await Promise.all([live(userId), live(null)]);
    return liveNotices([...own, ...everyone], userId, now);
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
