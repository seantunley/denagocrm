import { contactName } from "@/lib/format";

// A social-inbox conversation, grouped from Communication rows by contact/lead +
// channel. Shared by the full /inbox and the /messages PWA so both stay in sync.
export type InboxThread = {
  key: string;
  name: string;
  href: string | null;
  channel: "whatsapp" | "messenger" | "instagram" | "x";
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
    /** The customer's side of an outbound message — see lib/deliveryReceipts.ts. */
    deliveredAt: Date | null;
    seenAt: Date | null;
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
  deliveredAt?: Date | null;
  seenAt?: Date | null;
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
        deliveredAt: c.deliveredAt ?? null,
        seenAt: c.seenAt ?? null,
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

/** Assignment, staff notes, automation ownership and the in-progress reply. */
export type ThreadCollaboration = {
  conversationId: string;
  assignee: { id: string; name: string } | null;
  notes: { id: string; body: string; authorName: string; createdAt: Date }[];
  /**
   * `human` means the shared BotSession is paused and inbound turns are suppressed.
   * Unsupported is explicit so the UI never shows a control it cannot enforce.
   */
  bot: { supported: boolean; mode: "bot" | "human" };
  draft: { ownerId: string; ownerName: string; body: string; updatedAt: Date } | null;
};
