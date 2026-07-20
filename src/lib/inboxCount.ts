import "server-only";
import { prisma } from "./db";

/**
 * Unread inbound threads — powers the sidebar badge. Group messages into
 * conversations and count those whose newest message is inbound AND not yet
 * opened (readAt null). Opening the thread in the inbox clears it, so the badge
 * reflects "needs your eyes" rather than "needs a reply" — a read-but-unreplied
 * thread stays visible in the inbox (with a "Read" pill) but no longer nags here.
 */
export async function awaitingReplyCount(): Promise<number> {
  const comms = await prisma.communication.findMany({
    where: { type: { in: ["whatsapp", "messenger", "instagram"] }, archivedAt: null },
    orderBy: { occurredAt: "desc" },
    take: 400,
    select: { contactId: true, leadId: true, type: true, direction: true, readAt: true },
  });
  const seen = new Set<string>();
  let unread = 0;
  for (const c of comms) {
    const key = c.contactId ? `c:${c.contactId}:${c.type}` : c.leadId ? `l:${c.leadId}:${c.type}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (c.direction === "inbound" && c.readAt == null) unread += 1; // newest is theirs & unopened
  }
  return unread;
}
