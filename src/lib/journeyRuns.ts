import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { executeJourneyStep } from "./journeyStepExecutor";
import { loadJourneyContext, type JourneyEntityType, type JourneyContext } from "./journeyContext";
import { parseJourneyDefinition, stepById } from "./journeyTypes";
import { NEVER_STOP, type StopSignal } from "./stopSignal";
import { withEnrolmentLock } from "./journeyArbitration";
import { activeTenantPredicate } from "./tenantPredicate";
import { budgetStopUpdate } from "./journeyRunState";

const MAX_RUN_ATTEMPTS = 3;
const MAX_STEPS_PER_TICK = 20;
/** A single step can send an email or a WhatsApp message. */
const STEP_RESERVE_MS = 4_000;

async function updateStepLog(args: {
  runId: string;
  stepId: string;
  stepType: string;
  status: string;
  note?: string;
  output?: Record<string, unknown>;
}) {
  await prisma.journeyStepLog.upsert({
    where: { runId_stepId: { runId: args.runId, stepId: args.stepId } },
    create: {
      runId: args.runId,
      stepId: args.stepId,
      stepType: args.stepType,
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: ["completed", "skipped", "failed"].includes(args.status) ? new Date() : null,
    },
    update: {
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: ["completed", "skipped", "failed"].includes(args.status) ? new Date() : null,
    },
  });
}

/** Terminal states — a predecessor in any of these no longer blocks anyone. */
const CLOSED_RUN_STATUSES = ["completed", "failed", "cancelled"];

/**
 * Release runs parked behind a predecessor by run mode "queued".
 *
 * Without this they wait forever: `blocked` is not in the statuses
 * processJourneyRuns picks up, so nothing would ever start them. A run whose
 * predecessor has been PURGED is released too — a dangling id must not strand
 * it behind something that no longer exists.
 */
export async function releaseBlockedJourneyRuns(): Promise<number> {
  const blocked = await prisma.journeyRun.findMany({
    where: { status: "blocked" },
    // Oldest first, so a queue that has built up drains in the order it formed.
    orderBy: { createdAt: "asc" },
    select: { id: true, journeyId: true, entityType: true, entityId: true, blockedByRunId: true },
    take: 200,
  });
  if (blocked.length === 0) return 0;

  const predecessorIds = [...new Set(blocked.map((run) => run.blockedByRunId).filter((id): id is string => Boolean(id)))];
  const stillOpen = new Set(
    (
      await prisma.journeyRun.findMany({
        where: { id: { in: predecessorIds }, status: { notIn: CLOSED_RUN_STATUSES } },
        select: { id: true },
      })
    ).map((run) => run.id),
  );

  let released = 0;
  // At most ONE release per person per journey per sweep. Three runs queued
  // behind one predecessor all become eligible the moment it closes, and
  // releasing them together would start three at once — a queue that delivers
  // in parallel, which is the one thing the mode promises not to do. The rest
  // stay blocked and the next sweep takes the next one, because by then the
  // released run is itself open and holds the line.
  const releasedFor = new Set<string>();
  for (const run of blocked) {
    if (run.blockedByRunId && stillOpen.has(run.blockedByRunId)) continue;
    const lane = `${run.journeyId}:${run.entityType}:${run.entityId}`;
    if (releasedFor.has(lane)) continue;

    // Under the same lock enrolment takes, and re-checking the open runs inside
    // it: an enrolment arriving between the eligibility read above and this
    // write would otherwise be invisible, and the released run would start
    // beside it.
    const { count } = await withEnrolmentLock(run.journeyId, run.entityType, run.entityId, async (tx) => {
      const tenant = activeTenantPredicate("releaseBlockedJourneyRuns");
      const openNow = await tx.journeyRun.count({
        where: { ...tenant, journeyId: run.journeyId, entityType: run.entityType, entityId: run.entityId, status: { in: ["queued", "running", "waiting"] } },
      });
      if (openNow > 0) return { count: 0 };
      return tx.journeyRun.updateMany({
        where: { ...tenant, id: run.id, status: "blocked" },
        data: { status: "queued", nextRunAt: new Date(), blockedByRunId: null },
      });
    });
    if (count > 0) releasedFor.add(lane);
    released += count;
  }
  return released;
}

export async function recoverStaleJourneyRuns() {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  return prisma.journeyRun.updateMany({
    where: { status: "running", updatedAt: { lt: cutoff } },
    data: { status: "queued", nextRunAt: new Date(), lastError: "Recovered stale running journey" },
  });
}

/**
 * Drive ONE run to its next parking point.
 *
 * Exported so the manual-run action can process the run its own test produced,
 * instead of calling the global `processJourneyRuns(50)` and driving up to
 * fifty unrelated customers' journeys as a side effect of pressing "test".
 */
export async function processOneRun(runId: string, stop: StopSignal = NEVER_STOP) {
  const run = await prisma.journeyRun.findUnique({
    where: { id: runId },
    include: { journey: true, journeyVersion: true },
  });
  if (!run || !["queued", "waiting"].includes(run.status)) return false;

  const claimed = await prisma.journeyRun.updateMany({
    where: { id: run.id, status: { in: ["queued", "waiting"] }, nextRunAt: { lte: new Date() } },
    data: {
      status: "running",
      startedAt: run.startedAt ?? new Date(),
      lastError: null,
    },
  });
  if (claimed.count === 0) return false;

  // Parsing sits INSIDE its own guard, and the reason is blast radius.
  //
  // The run has just been claimed as "running". A throw from here escaped
  // processOneRun into processJourneyRuns and out of runJourneyEngine, so ONE
  // journey with an unparseable definition aborted the whole tenant tick: every
  // other run behind it stopped being processed, and this one sat claimed as
  // "running" until the 15-minute stale sweep — then did it again. A definition
  // is reachable in that state today by hand-editing it to an unknown step type
  // or a duplicate id.
  //
  // Failed outright rather than retried: a definition that will not parse is
  // deterministic, and three attempts at it only delay the same answer while
  // holding the run open.
  let definition;
  try {
    definition = parseJourneyDefinition(run.journeyVersion.definition);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unreadable journey definition";
    await prisma.journeyRun.updateMany({
      where: { id: run.id, status: "running" },
      data: {
        status: "failed",
        completedAt: new Date(),
        lastError: `Definition could not be read: ${message}`.slice(0, 1000),
      },
    });
    return false;
  }
  let currentStepId = run.currentStepId;
  let context = run.context as unknown as JourneyContext;
  const visited = new Set<string>();

  /**
   * Write to the run ONLY while we still own it.
   *
   * The claim above takes the run from queued/waiting to `running`, and that is
   * the whole of our title to it. Every later write used an unconditional
   * `update({ where: { id } })`, so a run cancelled mid-flight by run mode
   * `restart` was quietly resurrected: the worker finished its steps and wrote
   * `completed` straight over `cancelled`. The replacement run was already
   * sending by then, so the customer got both sequences — and the trace showed
   * two completed runs with nothing to say one had been superseded.
   *
   * Returns false when the row is no longer ours, which is the signal to stop
   * touching it and get out of the loop.
   */
  const stillOurs = async (data: Prisma.JourneyRunUpdateManyMutationInput) => {
    const { count } = await prisma.journeyRun.updateMany({
      where: { id: run.id, status: "running" },
      data,
    });
    return count > 0;
  };

  try {
    for (let count = 0; count < MAX_STEPS_PER_TICK; count++) {
      // Budget spent: park the run exactly where it is and RETURN.
      //
      // `break` here was wrong and actively harmful: falling out of the loop
      // lands on the "exceeded MAX_STEPS_PER_TICK" throw below, whose catch
      // marks the not-yet-executed step FAILED, increments attempts, and after
      // MAX_RUN_ATTEMPTS budget stops fails the journey permanently. Running out
      // of time is not an error and must not consume a retry.
      //
      // The run was claimed as "running", so it has to be put back to "queued"
      // explicitly — leaving it running would strand it until the stale-run
      // recovery sweep. attempts is deliberately untouched: a budget stop is not
      // an attempt, and any genuine earlier failures keep their count.
      if (stop.shouldStop(STEP_RESERVE_MS)) {
        await stillOurs(budgetStopUpdate(currentStepId, context as Prisma.InputJsonValue));
        return false;
      }
      const step = stepById(definition, currentStepId);
      if (!step) {
        const finished = await stillOurs({
          status: "completed",
          currentStepId: null,
          completedAt: new Date(),
          attempts: 0,
          context: context as Prisma.InputJsonValue,
        });
        // Cancelled out from under us while the last steps ran. Say nothing and
        // write nothing: the audit line and the "completed" status both belong
        // to the replacement run, not to this one.
        if (!finished) return false;
        await logAudit({
          action: "journey.completed",
          summary: `Journey “${run.journey.name}” completed`,
          leadId: run.leadId,
          contactId: run.contactId,
          userName: "Journey engine",
        });
        return true;
      }

      if (visited.has(step.id)) {
        throw new Error(`Journey cycle detected at step ${step.id}`);
      }
      visited.add(step.id);

      // Re-check ownership BEFORE the step runs, not just before the write.
      // Steps send email and WhatsApp, and an unsent message is recoverable
      // where a sent one is not — so the check that matters is the one in front
      // of the send. This narrows the window to a single step's execution; a
      // cancellation landing inside that window still gets one more send, which
      // would need cooperative cancellation to close and is not worth a
      // second connection per step.
      // Re-check ownership BEFORE the step runs, not just before the write.
      // Steps send email and WhatsApp, and an unsent message is recoverable
      // where a sent one is not — so the check that matters is the one in front
      // of the send. This narrows the window to a single step's execution; a
      // cancellation landing inside that window still gets one more send, which
      // would need cooperative cancellation to close.
      const owned = await prisma.journeyRun.count({ where: { id: run.id, status: "running" } });
      if (owned === 0) return false;

      await updateStepLog({
        runId: run.id,
        stepId: step.id,
        stepType: step.type,
        status: "running",
      });
      const result = await executeJourneyStep({
        step,
        context,
        category: run.journey.category,
        journeyName: run.journey.name,
        runId: run.id,
      });
      const nextStepId = result.nextStepId === undefined
        ? step.nextStepId ?? null
        : result.nextStepId;
      await updateStepLog({
        runId: run.id,
        stepId: step.id,
        stepType: step.type,
        status: result.status === "skipped" ? "skipped" : "completed",
        note: result.note,
        output: {
          ...result.output,
          nextStepId,
          nextRunAt: result.nextRunAt?.toISOString(),
        },
      });

      if (result.status === "waiting") {
        await stillOurs({
          status: "waiting",
          currentStepId: nextStepId,
          nextRunAt: result.nextRunAt ?? new Date(Date.now() + 60_000),
          attempts: 0,
          context: context as Prisma.InputJsonValue,
        });
        return true;
      }

      currentStepId = nextStepId;
      const refreshed = await loadJourneyContext(
        run.entityType as JourneyEntityType,
        run.entityId,
        (context.event ?? {}) as Record<string, unknown>
      );
      if (refreshed) context = refreshed;
      // Losing the row here means it was cancelled while this step ran. Stop
      // rather than carrying on to the next step of a run that no longer exists.
      const kept = await stillOurs({
        currentStepId,
        attempts: 0,
        context: context as Prisma.InputJsonValue,
      });
      if (!kept) return false;
    }

    throw new Error(`Journey exceeded ${MAX_STEPS_PER_TICK} immediate steps without waiting`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown journey run error";
    if (currentStepId) {
      const step = stepById(definition, currentStepId);
      if (step) {
        await updateStepLog({
          runId: run.id,
          stepId: step.id,
          stepType: step.type,
          status: "failed",
          note: message.slice(0, 1000),
        });
      }
    }
    const attempts = run.attempts + 1;
    const retry = attempts < MAX_RUN_ATTEMPTS;
    // Conditional like every other write here: a run cancelled mid-flight must
    // not be dragged back to "queued" by the failure of the step it was
    // cancelled during, which would put it back in the queue beside its
    // replacement.
    await stillOurs({
      status: retry ? "queued" : "failed",
      attempts,
      nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
      lastError: message.slice(0, 1000),
    });
    return false;
  }
}

export async function processJourneyRuns(limit = 40, stop: StopSignal = NEVER_STOP) {
  const runs = await prisma.journeyRun.findMany({
    where: {
      status: { in: ["queued", "waiting"] },
      nextRunAt: { lte: new Date() },
    },
    orderBy: { nextRunAt: "asc" },
    take: limit,
    select: { id: true },
  });
  let processed = 0;
  for (const run of runs) {
    if (stop.shouldStop(STEP_RESERVE_MS)) break;
    if (await processOneRun(run.id, stop)) processed++;
  }
  return processed;
}
