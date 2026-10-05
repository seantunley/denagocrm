import "server-only";
import { prisma } from "./db";
import { logError } from "./errorLog";
import { askCrm, type AssistantResult } from "./crmAssistant";
import { assistantAskAllowed, assistantUserFor } from "./assistantUser";
import { MAX_ACTIVE_SCHEDULES, SCHEDULE_SKIPPED_NOTE, SCHEDULE_UNSAVED_NOTE, nextRun, scheduleFailureNote } from "./assistantSchedule";
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

/**
 * One person's runs per tick. Ten schedules all set for "Monday 07:00" must not
 * take a whole tick from everyone else in the workspace; the rest stay due
 * (unclaimed) and run at the next tick.
 */
export const MAX_RUNS_PER_PERSON_PER_TICK = 3;

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
  const perPerson = new Map<string, number>();
  for (const schedule of due) {
    if (budget.shouldStop(SCHEDULE_RUN_RESERVE_MS)) break;
    if (schedule.tenantId !== tenantId) continue;
    // Over the per-person share: left unclaimed, so it is still due next tick.
    const theirs = perPerson.get(schedule.userId) ?? 0;
    if (theirs >= MAX_RUNS_PER_PERSON_PER_TICK) continue;

    // WHO they are is settled BEFORE the run is claimed. A failure to read it
    // (a database blip) touches nothing: the schedule is still due and is tried
    // again next tick — never consumed, never switched off. Only a definite "no
    // longer allowed" switches it off, and only if nobody has claimed it since.
    let user: Awaited<ReturnType<typeof assistantUserFor>>;
    try {
      user = await assistantUserFor(schedule.userId);
    } catch (error) {
      await logError("assistant-schedule", "couldn't check the person for a scheduled run", error instanceof Error ? error.name : "unknown");
      continue;
    }
    if (!user || user.id !== schedule.userId) {
      await prisma.assistantSchedule.updateMany({
        where: { id: schedule.id, tenantId, active: true, nextRunAt: schedule.nextRunAt },
        data: { active: false, nextRunAt: null },
      });
      continue;
    }

    // Then the claim: one conditional update, so overlapping ticks never run it twice.
    const now = new Date();
    const next = nextRun(schedule, now);
    const claim = await prisma.assistantSchedule.updateMany({
      where: { id: schedule.id, tenantId, active: true, nextRunAt: schedule.nextRunAt },
      data: { nextRunAt: next, lastRunAt: now, ...(next ? {} : { active: false }) },
    });
    if (claim.count !== 1) continue;
    perPerson.set(schedule.userId, theirs + 1);

    // The same per-person hourly ask limit as chat, voice and WhatsApp. Over
    // it, this run is skipped — it is already claimed, so it simply comes round
    // again at its next time — and the person is told rather than left waiting.
    const allowed = await assistantAskAllowed(user.id);
    const result: AssistantResult = !allowed
      ? { ok: false, error: "rate-limited" }
      : await askCrm(user, schedule.question, null, { source: "schedule", scheduleId: schedule.id })
          .catch(async (error: unknown) => {
            await logError("assistant-schedule", "scheduled run failed", error instanceof Error ? error.name : "unknown");
            return { ok: false as const, error: "failed" };
          });
    // A BRIEFING EXISTS only if askCrm answered AND saved it (`saved`). Anything
    // else — a failure, a skip, or an answer whose save failed — gets a short
    // note saved here instead, so the person sees why.
    const briefing = result.ok && result.saved;
    let delivered = briefing;
    if (!briefing) {
      const note = result.ok ? SCHEDULE_UNSAVED_NOTE : allowed ? scheduleFailureNote(result.error) : SCHEDULE_SKIPPED_NOTE;
      delivered = await prisma.assistantTurn
        .create({ data: { tenantId, userId: user.id, question: schedule.question, answer: note, source: "schedule", scheduleId: schedule.id } })
        .then(() => true)
        .catch(async (error: unknown) => {
          await logError("assistant-schedule", "schedule note write failed", error instanceof Error ? error.name : "unknown");
          return false;
        });
    }
    ran++;

    // The push points at something that is there: "ready" only for a saved
    // briefing, "couldn't run" only for a saved note — and nothing at all when
    // nothing could be saved (it would open onto an empty thread).
    if (delivered) {
      const name = parseProfile(await getSetting(ASSISTANT_PROFILE_KEY).catch(() => null)).name;
      await sendPushToAll(
        {
          title: name,
          body: briefing ? "Your scheduled briefing is ready." : "A scheduled question couldn't run — open to see why.",
          url: "/assistant",
        },
        "assistant",
        { tenantId, userId: user.id },
      ).catch((error: unknown) => logError("assistant-schedule", "push failed", error instanceof Error ? error.name : "unknown"));
    }
  }
  return { ran };
}
