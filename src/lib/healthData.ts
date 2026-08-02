import "server-only";
import { prisma } from "./db";
import { computeHealth, type HealthResult } from "./health";
import { getAccessibleContactIds, type PermissionUser } from "./permissions";

type Scores = { nps: number | null; csat: number | null };

/**
 * Latest NPS + CSAT score per contact, from completed survey responses.
 *
 * `contactIds === null` means "no ownership restriction" (owner / contacts.view_all),
 * matching getAccessibleContactIds. Anything else narrows the read to those
 * contacts, so a scoped caller never pulls another rep's customer sentiment into
 * memory on its way to being filtered out.
 */
async function surveyScoreMap(contactIds: string[] | null): Promise<Map<string, Scores>> {
  const rows = await prisma.surveyResponse.findMany({
    where: {
      status: "completed",
      contactId: contactIds === null ? { not: null } : { in: contactIds },
      score: { not: null },
    },
    include: { survey: { select: { type: true } } },
    orderBy: { completedAt: "desc" },
  });
  const map = new Map<string, Scores>();
  for (const r of rows) {
    if (!r.contactId) continue;
    const cur = map.get(r.contactId) ?? { nps: null, csat: null };
    if (r.survey.type === "nps") {
      if (cur.nps == null) cur.nps = r.score;
    } else if (cur.csat == null) {
      cur.csat = r.score;
    }
    map.set(r.contactId, cur);
  }
  return map;
}

export type ScoredContact = {
  id: string;
  firstName: string;
  lastName: string | null;
  company: string | null;
  isCompany: boolean;
  health: HealthResult;
};

/**
 * Score the caller's accessible contacts (bounded) for the health dashboard.
 *
 * The user is a REQUIRED argument, not an optional refinement: /health is gated
 * on `contacts.view_all` OR `contacts.view_owned` (ROUTE_RULES in routeAccess.ts),
 * and this query carried no ownership filter at all. A rep holding only
 * contacts.view_owned therefore opened /health and read tenant-wide customer
 * names, companies and health signals — including every contact they are
 * explicitly not allowed to open on /contacts. The scope has to live HERE rather
 * than at the one call site, so a second caller cannot forget it.
 *
 * `null` from getAccessibleContactIds means unrestricted (owner / view_all); an
 * empty array means "scoped, but nothing is accessible", which must score
 * nothing rather than fall through to an unfiltered read.
 */
export async function bulkHealth(user: PermissionUser): Promise<ScoredContact[]> {
  const contactIds = await getAccessibleContactIds(user);
  if (contactIds !== null && contactIds.length === 0) return [];
  const [contacts, scores] = await Promise.all([
    prisma.contact.findMany({
      where: contactIds === null ? {} : { id: { in: contactIds } },
      take: 3000,
      include: {
        vehicles: {
          select: {
            serviceRecords: { select: { serviceDate: true }, orderBy: { serviceDate: "desc" }, take: 1 },
            warrantyClaims: { where: { status: { in: ["open", "approved"] } }, select: { id: true } },
          },
        },
        leads: { where: { status: "won" }, select: { id: true } },
        communications: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
        referralsMade: { select: { id: true } },
      },
    }),
    surveyScoreMap(contactIds),
  ]);

  return contacts.map((c) => {
    const lastServiceAt = c.vehicles
      .map((v) => v.serviceRecords[0]?.serviceDate ?? null)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const openClaims = c.vehicles.reduce((s, v) => s + v.warrantyClaims.length, 0);
    const sc = scores.get(c.id) ?? { nps: null, csat: null };
    const health = computeHealth({
      cartCount: c.vehicles.length,
      wonCount: c.leads.length,
      lastServiceAt,
      lastContactAt: c.communications[0]?.occurredAt ?? null,
      referrals: c.referralsMade.length,
      openClaims,
      npsScore: sc.nps,
      csatScore: sc.csat,
    });
    return {
      id: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      company: c.company,
      isCompany: c.isCompany,
      health,
    };
  });
}

/**
 * Score a single contact (for the contact page card). The caller has already
 * proved access to THIS contact — the page reaches it through the contact
 * read-access gate — so no extra scope check is needed here; the survey read is
 * narrowed to the one contact whose card is being rendered.
 */
export async function contactHealth(contactId: string): Promise<HealthResult> {
  const [c, scores] = await Promise.all([
    prisma.contact.findUnique({
      where: { id: contactId },
      include: {
        vehicles: {
          select: {
            serviceRecords: { select: { serviceDate: true }, orderBy: { serviceDate: "desc" }, take: 1 },
            warrantyClaims: { where: { status: { in: ["open", "approved"] } }, select: { id: true } },
          },
        },
        leads: { where: { status: "won" }, select: { id: true } },
        communications: { select: { occurredAt: true }, orderBy: { occurredAt: "desc" }, take: 1 },
        referralsMade: { select: { id: true } },
      },
    }),
    surveyScoreMap([contactId]),
  ]);
  if (!c) return { score: 0, tier: "watch", reasons: [] };
  const lastServiceAt = c.vehicles
    .map((v) => v.serviceRecords[0]?.serviceDate ?? null)
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const openClaims = c.vehicles.reduce((s, v) => s + v.warrantyClaims.length, 0);
  const sc = scores.get(contactId) ?? { nps: null, csat: null };
  return computeHealth({
    cartCount: c.vehicles.length,
    wonCount: c.leads.length,
    lastServiceAt,
    lastContactAt: c.communications[0]?.occurredAt ?? null,
    referrals: c.referralsMade.length,
    openClaims,
    npsScore: sc.nps,
    csatScore: sc.csat,
  });
}
