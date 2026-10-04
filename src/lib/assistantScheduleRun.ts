import "server-only";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { askCrm, type AssistantResult } from "./crmAssistant";
import { assistantUserFor } from "./assistantUser";
import { MAX_ACTIVE_SCHEDULES, nextRun, scheduleFailureNote } from "./assistantSchedule";
import { currentTenantScope } from "./tenantScope";
import { sendPushToAll } from "./push";
import { getSetting } from "./settings";
import { ASSISTANT_PROFILE_KEY, parseProfile } from "./assistantSoul";
import type { CronSliceContext } from "./tenantCron";

/**
 * Budget to keep in hand before STARTING a scheduled question. askCrm's worst
 * case is three research rounds at 45 s each plus a 60 s answer — about 3 min
 * 15 s — so this is that plus the writes and the push.
 *
 * ponytail: runs are one at a time, so a 290 s tick starts at most a few —
 * fine while a workspace has a handful of schedules; when lots of people pick
 * the same "Monday 07:00" they queue across ticks (late, never lost — a
 * schedule stays due until it is claimed). Run a few in parallel per tick when
 * that lateness matters.
 */
export const SCHEDULE_RUN_RESERVE_MS = 200_000;

/** At most this many due schedules read per tick — far more than one tick can start. */
const DUE_BATCH = 20;

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Run `write` only while the person has a free slot (fewer than
 * MAX_ACTIVE_SCHEDULES active), under a per-person lock held to the end of the
 * transaction — so two Confirm clicks, or a Confirm and a Resume, can't both
 * pass the count. null = at the cap, nothing written.
 */
export async function withScheduleSlot<T>(userId: string, write: (tx: Tx) => Promise<T>): Promise<T | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`assistant-schedules:${userId}`})::bigint)`;
    if ((await tx.assistantSchedule.count({ where: { userId, active: true } })) >= MAX_ACTIVE_SCHEDULES) return null;
    return write(tx);
  });
}

/**
 * The person has now seen their scheduled answers (the bubble opened, or the
 * Ask page loaded): the unread dot goes. Their own turns only. Here rather than
 * in crmAssistant, whose one write stays its own conversation history.
 */
export async function markScheduledTurnsSeen(userId: string) {
  await prisma.assistantTurn.updateMany({
    where: { userId, source: "schedule", seenAt: null },
    data: { seenAt: new Date() },
  });
}

/**
 * Run the scheduled questions that are due in the workspace whose scope the
 * cron has already entered (runCronPerTenant). Oldest due first.
 *
 * Safe against overlapping ticks: each schedule is CLAIMED before it runs — one
 * conditional update that moves nextRunAt on only if it still holds the value
 * read here. Two runners that read the same row both try; exactly one sees
 * count 1, and the other skips it. The claim moves it to the next occurrence
 * after NOW, so missed runs are never made up (no 7-run backfill after an
 * outage); a one-off is switched off by its claim.
 *
 * Runs AS the person, re-checked at run time (assistantUserFor): left the
 * workspace, lost the assistant permission, module switched off → the schedule
 * is switched off and nothing runs. Their answer lands in their own thread;
 * a push tells them it's there, with no answer text in the notification.
 *
 * ONE WORKSPACE, NAMED: it runs only inside a real tenant scope — never a
 * system scope, never none — and names that tenant on every read and write
 * (due list, claim, switch-off, saved note, push) on top of the db guard and
 * RLS, so a scope or guard fault can't run one workspace's question as, or
 * for, anyone in another.
 */
export async function runDueAssistantSchedules(budget: CronSliceContext): Promise<{ ran: number }> {
  const scope = currentTenantScope();
  if (!scope || scope.system || !scope.tenantId) return { ran: 0 };
  const tenantId = scope.tenantId;

  const due = await prisma.assistantSchedule.findMany({
    where: { tenantId, active: true, nextRunAt: { lte: new Date() } },
    orderBy: { nextRunAt: "asc" },
    take: DUE_BATCH,
    select: { id: true, tenantId: true, userId: true, question: true, cadence: true, weekday: true, timeOfDay: true, onDate: true, nextRunAt: true },
  });
  let ran = 0;
  for (const schedule of due) {
    if (budget.shouldStop(SCHEDULE_RUN_RESERVE_MS)) break;
    if (schedule.tenantId !== tenantId) continue;
    const now = new Date();
    const next = nextRun(schedule, now);
    const claim = await prisma.assistantSchedule.updateMany({
      where: { id: schedule.id, tenantId, active: true, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: next, lastRunAt: now, ...(next ? {} : { active: false }) },
    });
    if (claim.count !== 1) continue;

    const user = await assistantUserFor(schedule.userId);
    if (!user || user.id !== schedule.userId) {
      await prisma.assistantSchedule.updateMany({ where: { id: schedule.id, tenantId }, data: { active: false, nextRunAt: null } });
      continue;
    }

    const result: AssistantResult = await askCrm(user, schedule.question, null, { source: "schedule", scheduleId: schedule.id })
      .catch(async (error: unknown) => {
        await logError("assistant-schedule", "scheduled run failed", error instanceof Error ? error.name : "unknown");
        return { ok: false as const, error: "failed" };
      });
    // askCrm saves the turn only when it answers; a failure is saved here, so
    // the person sees why instead of nothing.
    if (!result.ok) {
      await prisma.assistantTurn
        .create({
          data: {
            tenantId,
            userId: user.id,
            question: schedule.question,
            answer: scheduleFailureNote(result.error),
            source: "schedule",
            scheduleId: schedule.id,
          },
        })
        .catch((error: unknown) => logError("assistant-schedule", "failure note write failed", error instanceof Error ? error.name : "unknown"));
    }
    ran++;

    const name = parseProfile(await getSetting(ASSISTANT_PROFILE_KEY).catch(() => null)).name;
    await sendPushToAll(
      {
        title: name,
        body: result.ok ? "Your scheduled briefing is ready." : "A scheduled question couldn't run — open to see why.",
        url: "/assistant",
      },
      "assistant",
      { tenantId, userId: user.id },
    ).catch((error: unknown) => logError("assistant-schedule", "push failed", error instanceof Error ? error.name : "unknown"));
  }
  return { ran };
}
