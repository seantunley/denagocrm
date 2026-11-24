import "server-only";
import { prisma } from "@/lib/db";
import { loadAttentionList } from "@/lib/attention/load";
import type { AttentionBand } from "@/lib/attention/score";
import { loadTodayLeads } from "@/lib/leadScoreLoader";
import type { PermissionUser } from "@/lib/permissions";
import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { WORKLIST_VIEWS, worklistWhere, type WorklistView } from "./salesWorklistRules";

/**
 * The data the worklist adds to the leads list, loaded for the rows on the page
 * only (batched, never per row). Rankings and reasons come from the engines that
 * already own them — Today's lead score and the Attention Centre — so the list,
 * Today and the Attention Centre can never disagree about why a deal is listed.
 */

/** "At risk" is the Attention Centre's act-on bands, not every lead with a whisper of a signal. */
const AT_RISK_BANDS = new Set(["act", "urgent"]);

/**
 * The ranked ids for My priorities / At risk, best first, with each one's reason. Null for the other views.
 * Cached per request: the page's list and its tab counts ask for the same ranking.
 */
export const rankedLeads = cache(async (user: PermissionUser, view: WorklistView, now: Date) => {
  if (view === "priorities") {
    const { leads } = await loadTodayLeads(user, { mine: true }, now);
    return leads.map((lead) => ({ id: lead.id, reason: lead.reasons.join(" · ") }));
  }
  if (view === "atrisk") {
    const { leads } = await loadAttentionList(user, now);
    return leads.filter((lead) => AT_RISK_BANDS.has(lead.band)).map((lead) => ({ id: lead.id, reason: riskReason(lead.signals) }));
  }
  return null;
});

/** How many deals each view holds under the same filters and access — the tab counts. */
export async function worklistCounts(user: PermissionUser, filtersWhere: Prisma.LeadWhereInput, now: Date): Promise<Record<WorklistView, number>> {
  const counts = await Promise.all(
    WORKLIST_VIEWS.map(async (view) => {
      const ranked = await rankedLeads(user, view.key, now);
      const where = { AND: [filtersWhere, worklistWhere(view.key, now), ...(ranked ? [{ id: { in: ranked.map((row) => row.id) } }] : [])] };
      return [view.key, await prisma.lead.count({ where })] as const;
    }),
  );
  return Object.fromEntries(counts) as Record<WorklistView, number>;
}

/** Each listed open deal's health (the Attention Centre's band) and, when at risk, why (cached per request). */
export async function attentionFor(user: PermissionUser, leadIds: string[], now: Date): Promise<Map<string, { band: AttentionBand; reason: string }>> {
  if (leadIds.length === 0) return new Map();
  const wanted = new Set(leadIds);
  const { leads } = await loadAttentionList(user, now);
  return new Map(
    leads
      .filter((lead) => wanted.has(lead.id))
      .map((lead) => [lead.id, { band: lead.band, reason: AT_RISK_BANDS.has(lead.band) ? riskReason(lead.signals) : "" }]),
  );
}

const riskReason = (signals: { detail: string }[]) => signals.slice(0, 2).map((signal) => signal.detail).join(" · ");

export type NextAction = { summary: string; dueDate: Date; allDay: boolean };

/** Each deal's next planned activity and its last real contact or completed activity. */
export async function worklistColumns(leadIds: string[]) {
  if (leadIds.length === 0) return { next: new Map<string, NextAction>(), last: new Map<string, Date>() };
  const [planned, contacts, done] = await Promise.all([
    prisma.activity.findMany({
      where: { leadId: { in: leadIds }, status: "planned", availabilityBlock: false },
      select: { leadId: true, summary: true, dueDate: true, allDay: true },
      orderBy: { dueDate: "asc" },
    }),
    // A note is not contact with the customer.
    prisma.communication.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: { not: "note" } }, _max: { occurredAt: true } }),
    prisma.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, status: "done" }, _max: { doneAt: true } }),
  ]);
  const next = new Map<string, NextAction>();
  for (const row of planned) if (row.leadId && !next.has(row.leadId)) next.set(row.leadId, { summary: row.summary, dueDate: row.dueDate, allDay: row.allDay });
  const last = new Map<string, Date>();
  for (const at of [...contacts.map((r) => [r.leadId, r._max.occurredAt] as const), ...done.map((r) => [r.leadId, r._max.doneAt] as const)]) {
    const [leadId, when] = at;
    if (leadId && when && (!last.has(leadId) || last.get(leadId)! < when)) last.set(leadId, when);
  }
  return { next, last };
}
