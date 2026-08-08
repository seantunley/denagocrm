import { contactName } from "@/lib/format";

// A social-inbox conversation, grouped from Communication rows by contact/lead +
// channel. Shared by the full /inbox and the /messages PWA so both stay in sync.
export type InboxThread = {
  key: string;
  name: string;
  href: string | null;
  channel: "whatsapp" | "messenger" | "instagram";
  contactId: string | null;
  leadId: string | null;
  phone: string | null;
  awaiting: boolean;
  unread: boolean;
  archived: boolean;
  lastAt: Date;
  messages: {
    id: string;
    direction: string | null;
    body: string;
    at: Date;
    attachmentUrl: string | null;
    attachmentType: string | null;
  }[];
};

type CommRow = {
  id: string;
  type: string;
  direction: string | null;
  body: string;
  occurredAt: Date;
  attachmentUrl: string | null;
  attachmentType: string | null;
  readAt: Date | null;
  archivedAt: Date | null;
  contactId: string | null;
  leadId: string | null;
  contact:
    | {
        firstName: string;
        lastName?: string | null;
        company?: string | null;
        isCompany?: boolean;
        whatsapp?: string | null;
        phone?: string | null;
      }
    | null;
  lead: { name: string | null; phone: string | null } | null;
};

/** Group comms (already sorted newest-first) into threads, newest-first. */
export function buildInboxThreads(comms: CommRow[]): InboxThread[] {
  const threads = new Map<string, InboxThread>();
  for (const c of comms) {
    const key = c.contactId ? `c:${c.contactId}:${c.type}` : c.leadId ? `l:${c.leadId}:${c.type}` : null;
    if (!key) continue;
    let t = threads.get(key);
    if (!t) {
      t = {
        key,
        name: c.contact ? contactName(c.contact) : c.lead?.name ?? "Unknown",
        href: c.contactId ? `/contacts/${c.contactId}` : c.leadId ? `/leads/${c.leadId}` : null,
        channel: c.type as InboxThread["channel"],
        contactId: c.contactId,
        leadId: c.leadId,
        phone: c.contact?.whatsapp ?? c.contact?.phone ?? c.lead?.phone ?? null,
        // Newest message decides: archiving stamps the whole thread, and a fresh
        // inbound (archivedAt null) naturally brings it back to the inbox.
        awaiting: c.direction === "inbound",
        unread: c.direction === "inbound" && c.readAt == null,
        archived: c.archivedAt != null,
        lastAt: c.occurredAt,
        messages: [],
      };
      threads.set(key, t);
    }
    if (t.messages.length < 8) {
      t.messages.push({
        id: c.id,
        direction: c.direction,
        body: c.body,
        at: c.occurredAt,
        attachmentUrl: c.attachmentUrl,
        attachmentType: c.attachmentType,
      });
    }
  }
  return [...threads.values()].sort(
    (a, b) =>
      Number(b.unread) - Number(a.unread) ||
      Number(b.awaiting) - Number(a.awaiting) ||
      b.lastAt.getTime() - a.lastAt.getTime()
  );
}

/**
 * How a thread is identified for anything hung off it — assignment, notes.
 *
 * Stated HERE, beside buildInboxThreads, because the two must agree and this is
 * the file that decides. Collaboration lives on Conversation rows keyed by cuid;
 * a thread's identity is the composed string below. Nothing connects them except
 * both grouping the same way: one per contact-or-lead per channel, contact
 * winning when both are present.
 */
export type ThreadIdentity = {
  contactId: string | null;
  leadId: string | null;
  channel: string;
};

export function threadCollaborationKey(thread: ThreadIdentity): string | null {
  if (thread.contactId) return `c:${thread.contactId}:${thread.channel}`;
  if (thread.leadId) return `l:${thread.leadId}:${thread.channel}`;
  return null;
}

/** Assignment, staff notes and the in-progress reply for one thread. */
export type ThreadCollaboration = {
  conversationId: string;
  assignee: { id: string; name: string } | null;
  notes: { id: string; body: string; authorName: string; createdAt: Date }[];
  /**
   * The single reply draft, whoever owns it. Sent to the client with its OWNER so
   * the reply box can tell "restore what I was writing" from "a colleague is
   * already answering this" — two situations that look identical without it, and
   * the second is the one a shared inbox exists to prevent.
   */
  draft: { ownerId: string; ownerName: string; body: string; updatedAt: Date } | null;
};
