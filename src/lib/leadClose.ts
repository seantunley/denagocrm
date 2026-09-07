import { prisma } from "@/lib/db";

/**
 * Cancel the planned work on a lead that has just been closed.
 *
 * A lost lead kept every future activity it had. The lead vanished from the
 * board, so nobody saw the tasks on the lead itself — but the agenda, the
 * calendar and the overdue prompts all query activities by `status: "planned"`
 * without looking at the lead's status, so five "Call this new lead — introduce
 * yourself and book a demo" rows survive a spam lead being binned and keep
 * asking to be done. The reminder push and the FollowUpPrompts nag on them too.
 *
 * CANCELLED, NOT DELETED, and not "done": the activity is a record that the work
 * was scheduled, and the timeline should still show it was planned and why it
 * stopped. "done" would be a lie that inflates completion stats; deleting loses
 * the history. `cancelled` is the status the booking and journey code already
 * use for exactly this.
 *
 * ONLY `planned` rows are touched — an activity already done or cancelled is
 * settled history and stays as it is.
 *
 * Deliberately NOT applied to won leads. Closing a lead as won is not the same
 * event: a won deal routinely carries real scheduled work — delivery, handover,
 * the first service — and cancelling that would destroy live commitments rather
 * than tidy up dead ones. If won should sweep too, that is a product decision,
 * not a symmetry to assume.
 */
export async function cancelPlannedActivitiesForLostLead(leadId: string): Promise<number> {
  const { count } = await prisma.activity.updateMany({
    where: { leadId, status: "planned" },
    data: { status: "cancelled" },
  });
  return count;
}
