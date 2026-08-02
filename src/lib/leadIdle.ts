import { subDays } from "date-fns";
import { prisma } from "./db";
import { FOLLOW_UP_TYPE, isOpenFutureFollowUp } from "./followUp";

/**
 * "Has this lead really gone quiet?"
 *
 * Lifted verbatim out of the retired AutomationRule engine (`runIdleAutomations`
 * in src/lib/automations.ts) when the Journey engine became the only automation
 * engine. The journey scheduler's `lead_idle` enrolment tested nothing but
 * `lead.updatedAt < cutoff`, so retiring the rules engine without moving this
 * across would have been a silent regression: journeys would have nudged
 * customers who had a quote sitting with them awaiting a decision, or a
 * follow-up call already in the rep's diary.
 */

/**
 * The most recent moment a lead saw real engagement. `updatedAt` alone is not
 * enough — a lead can look stale on its row while a quote was just sent, a
 * WhatsApp came in, or an activity is scheduled. We take the latest of the
 * lead row, its newest communication, its newest activity (created or due), and
 * its newest quote. Returns null when a candidate should be skipped entirely
 * because it has a quote still pending a decision (a quote-pending state is not
 * "gone quiet").
 *
 * A logged activity's `createdAt` always counts (it is real past engagement),
 * but a future `dueDate` only counts for OPEN ("planned") activities — a
 * canceled or completed activity whose due date happens to sit in the future is
 * not a scheduled touch and must not suppress the gone-quiet nudge.
 *
 * Engagement is frequently recorded against the CONTACT rather than the lead:
 * an inbound WhatsApp matches a contact first, and the contact activity panel
 * schedules activities with a `contactId` and no `leadId`. So when the lead has
 * a `contactId` we widen every aggregate to include contact-linked rows too,
 * otherwise an active customer's lead could still be flagged idle.
 */
export async function lastEngagementAt(
  leadId: string,
  contactId: string | null,
  rowUpdatedAt: Date,
): Promise<Date | null> {
  const [pendingQuote, commAgg, activityAgg, plannedActivityAgg, quoteAgg] = await Promise.all([
    prisma.quote.findFirst({
      where: {
        status: "sent",
        signedAt: null,
        supersededAt: null,
        deletedAt: null,
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      select: { id: true },
    }),
    prisma.communication.aggregate({
      where: { OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])] },
      _max: { occurredAt: true },
    }),
    prisma.activity.aggregate({
      where: { OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])] },
      _max: { createdAt: true },
    }),
    prisma.activity.aggregate({
      where: {
        status: "planned",
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      _max: { dueDate: true },
    }),
    prisma.quote.aggregate({
      where: {
        deletedAt: null,
        OR: [{ leadId }, ...(contactId ? [{ contactId }] : [])],
      },
      _max: { updatedAt: true },
    }),
  ]);

  // A quote awaiting the customer's decision means the deal is live, not quiet.
  if (pendingQuote) return null;

  const candidates: Date[] = [rowUpdatedAt];
  if (commAgg._max.occurredAt) candidates.push(commAgg._max.occurredAt);
  if (activityAgg._max.createdAt) candidates.push(activityAgg._max.createdAt);
  if (plannedActivityAgg._max.dueDate) candidates.push(plannedActivityAgg._max.dueDate);
  if (quoteAgg._max.updatedAt) candidates.push(quoteAgg._max.updatedAt);

  return candidates.reduce((latest, d) => (d > latest ? d : latest), rowUpdatedAt);
}

/**
 * Whether a lead whose ROW is already older than the cutoff has genuinely gone
 * quiet — the full test, not just the row timestamp.
 *
 * A lead with an OPEN (status "planned") follow-up whose due date is still in
 * the future is never treated as gone quiet: the rep has an explicit check-back
 * scheduled, so the nudge is suppressed until the follow-up is due. Contact-
 * scoped follow-ups count too — the contact panel books them with a contactId
 * and no leadId.
 */
export async function leadHasGoneQuiet(
  lead: { id: string; contactId: string | null; updatedAt: Date },
  idleDays: number,
  now: Date,
): Promise<boolean> {
  const cutoff = subDays(now, idleDays);
  const lastEngagement = await lastEngagementAt(lead.id, lead.contactId, lead.updatedAt);
  // null = quote pending; >= cutoff = real recent engagement. Either way,
  // the lead is not "gone quiet".
  if (lastEngagement === null || lastEngagement >= cutoff) return false;

  const plannedFollowUps = await prisma.activity.findMany({
    where: {
      type: FOLLOW_UP_TYPE,
      status: "planned",
      OR: [{ leadId: lead.id }, ...(lead.contactId ? [{ contactId: lead.contactId }] : [])],
    },
    select: { type: true, status: true, dueDate: true },
  });
  return !plannedFollowUps.some((a) => isOpenFutureFollowUp(a, now));
}
