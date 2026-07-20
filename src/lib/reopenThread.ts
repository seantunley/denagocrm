import "server-only";
import { prisma } from "@/lib/db";

/**
 * A fresh inbound message reopens a conversation: clear any archived stamp on
 * the whole thread so its full history returns to the active inbox, instead of
 * the new message appearing alone while the older context stays in Archived.
 * Matches the "newest message decides" grouping in buildInboxThreads.
 */
export async function reopenThreadOnInbound(
  contactId: string | null,
  leadId: string | null,
  channel: string,
): Promise<void> {
  if (!contactId && !leadId) return;
  await prisma.communication.updateMany({
    where: {
      type: channel,
      archivedAt: { not: null },
      ...(contactId ? { contactId } : { leadId }),
    },
    data: { archivedAt: null },
  });
}
