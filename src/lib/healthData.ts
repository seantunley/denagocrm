import "server-only";
import { prisma } from "./db";
import { computeHealth, type HealthResult } from "./health";

type Scores = { nps: number | null; csat: number | null };

/** Latest NPS + CSAT score per contact, from completed survey responses. */
async function surveyScoreMap(): Promise<Map<string, Scores>> {
  const rows = await prisma.surveyResponse.findMany({
    where: { status: "completed", contactId: { not: null }, score: { not: null } },
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

/** Score every contact (bounded) for the health dashboard. */
export async function bulkHealth(): Promise<ScoredContact[]> {
  const [contacts, scores] = await Promise.all([
    prisma.contact.findMany({
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
    surveyScoreMap(),
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

/** Score a single contact (for the contact page card). */
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
    surveyScoreMap(),
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
