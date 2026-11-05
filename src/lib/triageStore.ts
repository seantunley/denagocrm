import { basePrisma } from "./db";
import { TRIAGE_KIND, type TriageDetails } from "./triageRules";

/**
 * Make this person's new triage run THE current one, in one step (review of #1007).
 *
 * Closing the old run and creating the new one used to be two writes, so two tabs that finished preparing at the same
 * moment could each close the old run before either created theirs — leaving two open runs whose cards could both
 * be done. Now both happen in ONE transaction, behind a per-person advisory lock: a second preparation waits for the
 * first to commit, then closes the run it just made. Exactly one open run per person, whatever the timing.
 *
 * Small and free of the assistant's imports so the integration harness can run it against real Postgres
 * (scripts/test-triage-prepare.ts).
 */
export async function replaceTriageRun(tenantId: string, userId: string, title: string, details: TriageDetails): Promise<string> {
  return basePrisma.$transaction(async (tx) => {
    // Held to the end of this transaction; keyed by workspace and person, so no one else waits.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`triage:${tenantId}:${userId}`}))::text AS "locked"`;
    await tx.assistantTask.updateMany({
      where: { tenantId, userId, kind: TRIAGE_KIND, status: "open" },
      data: { status: "closed", closedAt: new Date() },
    });
    const task = await tx.assistantTask.create({
      data: { tenantId, userId, kind: TRIAGE_KIND, title, details: details as never, steps: {} },
      select: { id: true },
    });
    return task.id;
  });
}
