import "server-only";
import { prisma } from "./db";
import { accessibleInboxWhere, type PermissionUser } from "./permissions";

/**
 * Unread inbound threads — powers the sidebar badge. Group messages into
 * conversations and count those whose newest message is inbound AND not yet
 * opened (readAt null). Opening the thread in the inbox clears it, so the badge
 * reflects "needs your eyes" rather than "needs a reply" — a read-but-unreplied
 * thread stays visible in the inbox (with a "Read" pill) but no longer nags here.
 *
 * Scoped to the caller's accessible contacts/leads so the badge matches what the
 * inbox actually shows them; view_all users see the global count as before.
 */
export async function awaitingReplyCount(user: PermissionUser): Promise<number> {
  const scopeWhere = await accessibleInboxWhere(user);
  const comms = await prisma.communication.findMany({
    where: { type: { in: ["whatsapp", "messenger", "instagram"] }, ...scopeWhere, archivedAt: null },
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
