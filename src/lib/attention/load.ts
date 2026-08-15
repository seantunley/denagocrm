import "server-only";
import { cache } from "react";

import { prisma } from "../db";
import { getAccessibleLeadIds, type PermissionUser } from "../permissions";
import { collectAttentionSignals, type AttentionStage } from "./signals";
import {
  attentionBand,
  compareAttention,
  isDismissed,
  isSnoozed,
  needsAttention,
  scoreAttention,
  type AttentionBand,
  type AttentionSignal,
} from "./score";

/**
 * The Attention Centre's loader.
 *
 * ── COMPUTED ON READ. NO STORED SCORE. ──────────────────────────────────────
 *
 * Two of the five signals are functions of the CLOCK — `stage_age` and
 * `quote_expiring` change when nothing happens at all — so a stored score is
 * stale the moment it is written. Keeping one fresh means a cron rewriting every
 * open lead every few minutes: continuous write amplification across the whole
 * open pipeline, forever, to save five indexed reads per page view.
 *
 * The working set makes that trade easy. Every query is tenant- AND
 * permission-scoped, so a request sees one workspace's OPEN leads — hundreds, not
 * millions. Five indexed reads over that plus an in-memory join is cheaper than
 * the leads board already is; that page runs two `DISTINCT ON` raw queries, a
 * quote lookup, a signature lookup and a pinned-note join.
 *
 * WHEN TO REVISIT, said now so the decision stays revisitable rather than
 * religious: a tenant crossing roughly 10k open leads, or a cross-tenant digest
 * that must rank with no session. The fix then is a materialised view or a
 * partial index — a denormalised column and a cron only after those.
 *
 * `cache()` per request, the same treatment `dashboard/data.ts` gives its
 * queries, so a page header's count and its list body are one execution.
 */

export type AttentionLead = {
  id: string;
  /**
   * WHO. `Lead.name` is the person; `Lead.title` is the opportunity, which is
   * usually the product — so two deals for the same model rendered as two
   * identical rows, and the list was unreadable at exactly the moment it had
   * several things to show. The board has always led with `name` for this reason.
   */
  name: string;
  /** WHAT, shown second and only when it says something the name does not. */
  opportunity: string | null;
  valueCents: number;
  stageId: string;
  stageName: string;
  ownerName: string | null;
  contactId: string | null;
  signals: AttentionSignal[];
  score: number;
  band: AttentionBand;
};

/** A lead somebody has set aside, and the reason they gave. */
export type SetAsideLead = {
  id: string;
  name: string;
  reason: string;
  /** When it returns (snoozed) or when it was taken off (dismissed). */
  at: Date;
};

export type AttentionList = {
  leads: AttentionLead[];
  /**
   * Set-aside leads that WOULD otherwise be listed, with their reasons.
   *
   * Kept as two lists because they are two different states — "back on the 19th"
   * and "does not belong here" are answers to different questions — and carried
   * rather than counted, because "why is this not here" is what the reason exists
   * to answer and a bare number cannot. They are already loaded, so splitting
   * them costs nothing.
   */
  snoozed: SetAsideLead[];
  dismissed: SetAsideLead[];
};

/**
 * Every open, accessible lead that has at least one signal, ranked.
 *
 * Closed leads are excluded at the source rather than filtered afterwards: a won
 * or lost deal has no next step by definition, so every one of them would raise
 * `no_next_step` and the list would be mostly finished work.
 */
export const loadAttentionList = cache(async (user: PermissionUser, now: Date = new Date()): Promise<AttentionList> => {
  // The SHARED scope helper — `/leads`, `/leads/list`, `/leads/closed` and the
  // dashboard all use it. Its contract: `null` is unrestricted, and `[]` must
  // become an impossible match rather than an absent filter, which is the bug
  // that turns a scoped list into a full one.
  const accessibleIds = await getAccessibleLeadIds(user);
  if (accessibleIds !== null && accessibleIds.length === 0) return { leads: [], snoozed: [], dismissed: [] };

  const leads = await prisma.lead.findMany({
    where: {
      status: "open",
      deletedAt: null,
      ...(accessibleIds === null ? {} : { id: { in: accessibleIds } }),
    },
    select: {
      id: true,
      name: true,
      title: true,
      valueCents: true,
      stageId: true,
      contactId: true,
      stageEnteredAt: true,
      attentionSnoozedUntil: true,
      attentionSnoozeReason: true,
      attentionDismissedAt: true,
      attentionDismissReason: true,
      stage: { select: { id: true, name: true, staleAfterDays: true } },
      assignedTo: { select: { name: true } },
    },
  });
  if (leads.length === 0) return { leads: [], snoozed: [], dismissed: [] };

  const stages = new Map<string, AttentionStage>();
  const stageByLead = new Map<string, string>();
  const stageEnteredByLead = new Map<string, Date>();
  for (const lead of leads) {
    if (lead.stage) stages.set(lead.stage.id, { staleAfterDays: lead.stage.staleAfterDays });
    stageByLead.set(lead.id, lead.stageId);
    stageEnteredByLead.set(lead.id, lead.stageEnteredAt);
  }

  const signals = await collectAttentionSignals({
    leadIds: leads.map((lead) => lead.id),
    now,
    stages,
    stageByLead,
    stageEnteredByLead,
  });

  const snoozed: SetAsideLead[] = [];
  const dismissed: SetAsideLead[] = [];
  const rows: AttentionLead[] = [];
  for (const lead of leads) {
    const own = signals.get(lead.id) ?? [];
    if (!needsAttention(own)) continue;
    // Collected BEFORE being dropped, so the page can say what was set aside and
    // why rather than silently showing a shorter list than the person expects.
    //
    // DISMISS IS CHECKED FIRST. A lead can carry both — snoozed in March, then
    // dismissed in April — and the later, stronger decision is the one that
    // describes where it is. Checking snooze first would have a dismissed deal
    // reappear the moment its old snooze elapsed.
    if (isDismissed(lead.attentionDismissedAt)) {
      dismissed.push({
        id: lead.id,
        name: lead.name,
        reason: lead.attentionDismissReason ?? "",
        at: lead.attentionDismissedAt!,
      });
      continue;
    }
    if (isSnoozed(lead.attentionSnoozedUntil, now)) {
      snoozed.push({
        id: lead.id,
        name: lead.name,
        reason: lead.attentionSnoozeReason ?? "",
        at: lead.attentionSnoozedUntil!,
      });
      continue;
    }
    const score = scoreAttention(own);
    rows.push({
      id: lead.id,
      name: lead.name,
      // Shown only when it adds something. `title` is often exactly the product
      // name, and repeating it under the person's name is noise that pushes the
      // reasons — the part being read — further down.
      opportunity: lead.title && lead.title !== lead.name ? lead.title : null,
      valueCents: lead.valueCents,
      stageId: lead.stageId,
      stageName: lead.stage?.name ?? "—",
      ownerName: lead.assignedTo?.name ?? null,
      contactId: lead.contactId,
      // Heaviest reason first, so the sentence a person reads first is the one
      // that earned the ranking.
      signals: [...own].sort((a, b) => b.weight - a.weight),
      score,
      band: attentionBand(score),
    });
  }

  rows.sort(compareAttention);
  snoozed.sort((a, b) => a.at.getTime() - b.at.getTime());
  dismissed.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { leads: rows, snoozed, dismissed };
});
