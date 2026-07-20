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
