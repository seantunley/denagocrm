import "server-only";
import { basePrisma, prisma } from "./db";
import { actingTenantId } from "./actingTenant";
import { emailKey } from "./contactMatch";
import { phoneTail } from "./phoneMatch";
import { getAccessibleContactIds, getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { CONTACT_CHECKS, DEAL_CHECKS, bySource, cleanShare, failing, snapshotDay } from "./dataQualityRules";

/*
 * DATA QUALITY CENTRE — the database half (rules: dataQualityRules.ts). Reads only the customers and deals this person
 * may open (the CRM's own access lists), so a salesperson sees the quality of their own book and a manager the whole
 * workspace. The daily snapshot — the trend — is written and shown only for someone who sees EVERYTHING, so it is
 * always the workspace's score, never one person's slice.
 */

// ponytail: every accessible customer and deal is read and checked in memory (as the Duplicates page does); fine to tens
// of thousands — move the counts into SQL if a workspace outgrows that.
const LIMIT = 20_000;

export async function loadDataQuality(user: PermissionUser) {
  const tenantId = await actingTenantId();
  const [contactIds, leadIds] = await Promise.all([getAccessibleContactIds(user), getAccessibleLeadIds(user)]);
  const scoped = (ids: string[] | null) => (ids === null ? {} : { id: { in: ids } });
  const [contacts, deals] = await Promise.all([
    contactIds !== null && contactIds.length === 0
      ? []
      : prisma.contact.findMany({
          where: scoped(contactIds),
          select: { id: true, firstName: true, lastName: true, company: true, isCompany: true, email: true, phone: true, whatsapp: true, ownerId: true, source: true },
          orderBy: { createdAt: "desc" },
          take: LIMIT,
        }),
    leadIds !== null && leadIds.length === 0
      ? []
      : prisma.lead.findMany({
          where: scoped(leadIds),
          select: { id: true, title: true, name: true, status: true, contactId: true, valueCents: true, assignedToId: true, email: true, phone: true, contact: { select: { email: true, phone: true } } },
          orderBy: { createdAt: "desc" },
          take: LIMIT,
        }),
  ]);

  const contactProblems = failing(contacts, CONTACT_CHECKS);
  const dealProblems = failing(deals, DEAL_CHECKS);

  // Possible duplicates: the Duplicates page's own rules (email case-insensitive, the phone's last digits).
  const groups = new Map<string, Set<string>>();
  for (const c of contacts) {
    for (const key of [emailKey(c.email) && `e:${emailKey(c.email)}`, phoneTail(c.phone) && `p:${phoneTail(c.phone)}`]) {
      if (!key) continue;
      const group = groups.get(key) ?? new Set<string>();
      group.add(c.id);
      groups.set(key, group);
    }
  }
  const duplicateGroups = [...groups.values()].filter((g) => g.size > 1).length;

  const contactScore = cleanShare(contacts, CONTACT_CHECKS);
  const dealScore = cleanShare(deals, DEAL_CHECKS);
  const total = contacts.length + deals.length;
  const score = total ? Math.round((contactScore * contacts.length + dealScore * deals.length) / total) : 100;
  const counts: Record<string, number> = { duplicates: duplicateGroups };
  for (const [key, rows] of Object.entries(contactProblems)) counts[`contact.${key}`] = rows.length;
  for (const [key, rows] of Object.entries(dealProblems)) counts[`deal.${key}`] = rows.length;

  // The trend: the workspace's own score, so only for someone who sees all of it.
  const wholeWorkspace = contactIds === null && leadIds === null;
  let trend: { day: string; score: number }[] = [];
  if (wholeWorkspace) {
    const day = snapshotDay();
    await basePrisma.dataQualitySnapshot
      .create({ data: { tenantId, day, score, contactScore, dealScore, counts } })
      .catch((error: unknown) => {
        // Today's is already recorded (the first look of the day stands).
        if ((error as { code?: string }).code !== "P2002") throw error;
      });
    trend = (await basePrisma.dataQualitySnapshot.findMany({ where: { tenantId }, orderBy: { day: "desc" }, take: 30, select: { day: true, score: true } })).reverse();
  }

  return {
    score, contactScore, dealScore,
    contacts: contacts.length, deals: deals.length,
    contactProblems, dealProblems, duplicateGroups,
    sources: bySource(contacts),
    wholeWorkspace, trend,
    truncated: contacts.length === LIMIT || deals.length === LIMIT,
  };
}
