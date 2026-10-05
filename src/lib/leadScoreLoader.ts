import "server-only";

import { prisma } from "./db";
import { getAccessibleLeadIds, type PermissionUser } from "./permissions";
import { scoreLead, type LeadScore } from "./leadScore";
import { contactActivityWhere, contactCommunicationWhere } from "./customerContact";

/**
 * Lead score — the IMPURE half: gathers the signals `scoreLead` reads.
 *
 * Computed on read, never stored, for the reason the Attention Centre gives
 * (src/lib/attention/load.ts): half the inputs are functions of the clock, so a
 * stored score is stale the moment it is written.
 *
 * Every read goes through the tenant-scoped `prisma`, and the candidate list
 * through `getAccessibleLeadIds` — a queue that tells a rep who to call must not
 * be able to name a deal they cannot open.
 *
 * Six grouped queries over the id set, then an in-memory join: a fixed number of
 * round trips whether the list holds one lead or five hundred.
 */

/**
 * ponytail: 500-lead ceiling, most recently updated first. A rep who can see
 * more open deals than this loses the least recently touched ones from Today
 * (the page says so). Upgrade path: pre-rank in SQL by the engagement signals
 * before applying the cap.
 */
export const TODAY_CANDIDATE_CAP = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The lead fields scoring needs. Both callers already select these. */
export type ScorableLead = {
  id: string;
  valueCents: number;
  status: string;
  createdAt: Date;
  stageEnteredAt: Date;
  stage: { name: string; isClosed: boolean; staleAfterDays: number | null };
};

const latest = (a: Date | null | undefined, b: Date | null | undefined) =>
  !a ? b ?? null : !b ? a : a > b ? a : b;

/**
 * Scores a set of leads the caller has ALREADY access-checked. Does not
 * re-derive access: pass it only rows you were allowed to read.
 */
export async function scoreLeads(leads: ScorableLead[], now: Date = new Date()): Promise<Map<string, LeadScore>> {
  const out = new Map<string, LeadScore>();
  if (leads.length === 0) return out;
  const leadId = { in: leads.map((lead) => lead.id) };

  const [contact, inbound, done, planned, viewed, outstanding] = await Promise.all([
    // Contact means the customer (customerContact.ts): a note is something WE
    // wrote down, and a ticked-off to-do or blocked-out time isn't a touch either.
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, ...contactCommunicationWhere }, _max: { occurredAt: true } }),
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId, direction: "inbound" }, _max: { occurredAt: true } }),
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId, ...contactActivityWhere }, _max: { doneAt: true } }),
    // The EARLIEST planned activity answers both questions at once: none means no
    // next step, and one in the past means something is overdue.
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId, status: "planned" }, _min: { dueDate: true } }),
    // A signed quote's view is history, not interest.
    prisma.quote.groupBy({ by: ["leadId"], where: { leadId, deletedAt: null, signedAt: null }, _max: { viewedAt: true } }),
    // Superseded quotes have been replaced; chasing one is noise.
    prisma.quote.groupBy({
      by: ["leadId"],
      where: { leadId, deletedAt: null, status: "sent", signedAt: null, supersededAt: null },
      _count: { _all: true },
    }),
  ]);

  const byLead = <T extends { leadId: string | null }, V>(rows: T[], pick: (row: T) => V) =>
    new Map(rows.filter((row) => row.leadId).map((row) => [row.leadId as string, pick(row)]));
  const lastComm = byLead(contact, (row) => row._max.occurredAt);
  const lastInbound = byLead(inbound, (row) => row._max.occurredAt);
  const lastDone = byLead(done, (row) => row._max.doneAt);
  const nextPlanned = byLead(planned, (row) => row._min.dueDate);
  const quoteViewed = byLead(viewed, (row) => row._max.viewedAt);
  const quoteOutstanding = new Set(outstanding.map((row) => row.leadId));

  for (const lead of leads) {
    const next = nextPlanned.get(lead.id) ?? null;
    out.set(
      lead.id,
      scoreLead(
        {
          valueCents: lead.valueCents,
          status: lead.status,
          stageName: lead.stage.name,
          stageIsClosed: lead.stage.isClosed,
          daysInStage: Math.floor((now.getTime() - lead.stageEnteredAt.getTime()) / DAY_MS),
          staleAfterDays: lead.stage.staleAfterDays,
          lastContactAt: latest(lastComm.get(lead.id), lastDone.get(lead.id)),
          lastInboundAt: lastInbound.get(lead.id) ?? null,
          quoteViewedAt: quoteViewed.get(lead.id) ?? null,
          quoteSentNotSigned: quoteOutstanding.has(lead.id),
          hasOverdueActivity: next !== null && next < now,
          nextPlannedActivityAt: next,
          createdAt: lead.createdAt,
        },
        now,
      ),
    );
  }
  return out;
}

export type TodayLead = {
  id: string;
  /** The person — what the rep calls. */
  name: string;
  /** The opportunity, only when it says something the name does not. */
  opportunity: string | null;
  valueCents: number;
  stageName: string;
  assignedToName: string | null;
} & LeadScore;

/**
 * The signed-in rep's open leads, best to act on first. `mine` narrows to deals
 * assigned to them; it never widens past what `getAccessibleLeadIds` allows.
 */
export async function loadTodayLeads(
  user: PermissionUser,
  { mine }: { mine: boolean },
  now: Date = new Date(),
): Promise<{ leads: TodayLead[]; truncated: boolean }> {
  // null = unrestricted within the tenant; [] = nothing, and must stay an
  // impossible match rather than become an absent filter.
  const accessibleIds = await getAccessibleLeadIds(user);
  if (accessibleIds !== null && accessibleIds.length === 0) return { leads: [], truncated: false };

  const rows = await prisma.lead.findMany({
    where: {
      status: "open",
      deletedAt: null,
      stage: { isClosed: false },
      ...(accessibleIds === null ? {} : { id: { in: accessibleIds } }),
      ...(mine ? { assignedToId: user.id } : {}),
    },
    select: {
      id: true,
      name: true,
      title: true,
      valueCents: true,
      status: true,
      createdAt: true,
      stageEnteredAt: true,
      stage: { select: { name: true, isClosed: true, staleAfterDays: true } },
      assignedTo: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
    // One extra row tells us whether the cap cut anything off.
    take: TODAY_CANDIDATE_CAP + 1,
  });
  const truncated = rows.length > TODAY_CANDIDATE_CAP;
  const candidates = rows.slice(0, TODAY_CANDIDATE_CAP);
  const scores = await scoreLeads(candidates, now);

  const leads: TodayLead[] = [];
  for (const row of candidates) {
    const score = scores.get(row.id);
    if (!score || score.score === 0) continue;
    leads.push({
      id: row.id,
      name: row.name,
      opportunity: row.title && row.title !== row.name ? row.title : null,
      valueCents: row.valueCents,
      stageName: row.stage.name,
      assignedToName: row.assignedTo?.name ?? null,
      ...score,
    });
  }
  // Value breaks ties: between two equally warm deals, the bigger one first.
  leads.sort((a, b) => b.score - a.score || b.valueCents - a.valueCents);
  return { leads, truncated };
}
