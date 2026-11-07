"use server";

import { prisma } from "@/lib/db";
import { withActingStaffScope } from "@/lib/actingScope";
import { requireUser } from "@/lib/auth";
import { contactName } from "@/lib/format";
import {
  canAccessContact,
  canAccessLead,
  getAccessibleContactIds,
  getAccessibleLeadIds,
  hasAnyPermission,
  type PermissionUser,
} from "@/lib/permissions";
import type { CaptureRecord, CaptureTargetRef } from "@/lib/captureTarget";

/**
 * The records the phone's Capture sheet can file against (components/CaptureSheet.tsx).
 *
 * Wrapped in `withActingStaffScope` like actions/search.ts: a Server Action does
 * not inherit the scope a page render establishes, and every read here is
 * tenant-guarded. Access is the CRM's own lists — getAccessibleContactIds /
 * getAccessibleLeadIds — so this cannot offer a record its page would refuse.
 *
 * The sheet needs more than the command palette's hit: the number WhatsApp
 * opens, and the lead AND customer ids a communication is filed with. That is
 * why this is not `searchRecords`.
 */

const CONTACT_SELECT = { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true, whatsapp: true } as const;
const LEAD_SELECT = { id: true, title: true, name: true, phone: true, contactId: true, stage: { select: { name: true } }, status: true, contact: { select: { phone: true, whatsapp: true } } } as const;

type ContactRow = { id: string; firstName: string; lastName: string | null; company: string | null; isCompany: boolean; email: string | null; phone: string | null; whatsapp: string | null };
type LeadRow = { id: string; title: string; name: string; phone: string | null; contactId: string | null; stage: { name: string }; status: string; contact: { phone: string | null; whatsapp: string | null } | null };

function contactRecord(row: ContactRow): CaptureRecord {
  return { type: "contact", id: row.id, label: contactName(row), sublabel: row.email ?? row.phone ?? "", phone: row.whatsapp || row.phone || null, leadId: null, contactId: row.id };
}

function leadRecord(row: LeadRow): CaptureRecord {
  // The same number the lead's page dials: the lead's own, else its customer's.
  const phone = row.phone || row.contact?.whatsapp || row.contact?.phone || null;
  return { type: "lead", id: row.id, label: row.title, sublabel: `${row.name} · ${row.status === "open" ? row.stage.name : row.status}`, phone, leadId: row.id, contactId: row.contactId };
}

async function kinds(user: PermissionUser) {
  const [contacts, leads] = await Promise.all([
    hasAnyPermission(user, "contacts.view_all", "contacts.view_owned"),
    hasAnyPermission(user, "leads.view_all", "leads.view_owned"),
  ]);
  return { contacts, leads };
}

/** Customers and leads matching every word of the term, most recently touched first, a handful of each. */
export async function searchCaptureRecords(term: string): Promise<CaptureRecord[]> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const query = term.trim();
    if (query.length < 2) return [];
    const allowed = await kinds(user);
    const words = query.split(/\s+/).slice(0, 4);
    const contains = (word: string) => ({ contains: word, mode: "insensitive" as const });
    const [contactIds, leadIds] = await Promise.all([
      allowed.contacts ? getAccessibleContactIds(user) : [],
      allowed.leads ? getAccessibleLeadIds(user) : [],
    ]);
    // `[]` is "none" and must stay an impossible match; `null` is unrestricted.
    const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
    const [contacts, leads] = await Promise.all([
      contactIds !== null && contactIds.length === 0 ? [] : prisma.contact.findMany({
        where: { ...scoped(contactIds), deletedAt: null, AND: words.map((w) => ({ OR: [{ firstName: contains(w) }, { lastName: contains(w) }, { company: contains(w) }, { email: contains(w) }, { phone: contains(w) }] })) },
        select: CONTACT_SELECT,
        orderBy: { updatedAt: "desc" },
        take: 6,
      }),
      leadIds !== null && leadIds.length === 0 ? [] : prisma.lead.findMany({
        where: { ...scoped(leadIds), deletedAt: null, AND: words.map((w) => ({ OR: [{ title: contains(w) }, { name: contains(w) }, { email: contains(w) }, { phone: contains(w) }] })) },
        select: LEAD_SELECT,
        orderBy: { updatedAt: "desc" },
        take: 6,
      }),
    ]);
    return [...leads.map(leadRecord), ...contacts.map(contactRecord)];
  });
}

/** The record the sheet opened on (lib/captureTarget.ts decided which from the address). Null when it may not be opened. */
export async function loadCaptureRecord(ref: CaptureTargetRef): Promise<CaptureRecord | null> {
  return withActingStaffScope(async () => {
    const user = await requireUser();
    const allowed = await kinds(user);
    if (ref.type === "lead") {
      if (!allowed.leads || !(await canAccessLead(user, ref.id))) return null;
      const row = await prisma.lead.findFirst({ where: { id: ref.id, deletedAt: null }, select: LEAD_SELECT });
      return row ? leadRecord(row) : null;
    }
    if (!allowed.contacts || !(await canAccessContact(user, ref.id))) return null;
    const row = await prisma.contact.findFirst({ where: { id: ref.id, deletedAt: null }, select: CONTACT_SELECT });
    return row ? contactRecord(row) : null;
  });
}
