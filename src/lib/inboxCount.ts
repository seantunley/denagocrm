import "server-only";
import { prisma } from "./db";

/**
 * Threads waiting on a reply — same definition as the Social Inbox "All" tab:
 * group messages into conversations, count those whose newest message is
 * inbound. Powers the sidebar badge.
 */
export async function awaitingReplyCount(): Promise<number> {
  const comms = await prisma.communication.findMany({
    where: { type: { in: ["whatsapp", "messenger", "instagram"] } },
    orderBy: { occurredAt: "desc" },
    take: 400,
    select: { contactId: true, leadId: true, type: true, direction: true },
  });
  const seen = new Set<string>();
  let awaiting = 0;
  for (const c of comms) {
    const key = c.contactId ? `c:${c.contactId}:${c.type}` : c.leadId ? `l:${c.leadId}:${c.type}` : null;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (c.direction === "inbound") awaiting += 1; // newest in thread is theirs
  }
  return awaiting;
}
