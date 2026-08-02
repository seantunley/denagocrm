import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { executeJourneyStep, resolveTopLevelNext } from "./journeyStepExecutor";
import { loadJourneyContext, type JourneyEntityType, type JourneyContext } from "./journeyContext";
import { parseJourneyDefinition } from "./journeyTypes";
import { AbortJourney, ConditionFailed, StopJourney, isControlFlow } from "./journeyControlFlow";
import { parseCursor, withRepeatVars, type JourneyCursor } from "./journeyCursor";
import {
  advanceCursor,
  chooseBranch,
  enterChoose,
  enterRepeat,
  journeyScriptCache,
  pushFrame,
  resolveCursor,
  type CursorPosition,
  type ScriptLookup,
} from "./journeyScript";
import { NEVER_STOP, type StopSignal } from "./stopSignal";
import { budgetStopUpdate } from "./journeyRunState";

const MAX_RUN_ATTEMPTS = 3;
const MAX_STEPS_PER_TICK = 20;
/**
 * The LIFETIME step budget for one run, and the replacement for the `visited`
 * Set that used to sit in the step loop.
 *
 * That Set was a cycle detector: revisiting a step id within a tick threw. It
 * was wrong in both directions. Too strict, because a `repeat` re-executes the
 * same step ids on purpose — every loop would have been reported as a cycle. Too
 * weak, because it was rebuilt from empty on every tick, so the actual infinite
 * automation — a back-edge with a `wait` in it — went round forever, one step
 * per tick, and was never caught at all.
 *
 * What genuinely bounds a run is total work done, counted durably. `stepsExecuted`
 * is persisted on the row, so it survives parks, waits and process restarts, and
 * a run that will not terminate hits this ceiling and ABORTS (no retry — a loop
 * that did not end in 500 steps will not end in the next three attempts either).
 * Legitimate loops spend the budget honestly; 100 iterations of a four-step body
 * is 400, so this leaves room for one full-size repeat plus its surroundings.
 */
const MAX_STEPS_PER_RUN = 500;
/** A single step can send an email or a WhatsApp message. */
const STEP_RESERVE_MS = 4_000;

async function updateStepLog(args: {
  runId: string;
  /** Hierarchical trace path — the identity of one EXECUTION of a step. */
  path: string;
  stepId: string;
  stepType: string;
  status: string;
  note?: string;
  output?: Record<string, unknown>;
}) {
  const done = ["completed", "skipped", "failed"].includes(args.status);
  await prisma.journeyStepLog.upsert({
    // Keyed on the PATH, not the step id. `@@unique([runId, stepId])` could not
    // survive `repeat`: the same step id executes on every iteration, and the
    // second write would have collided with the first — or, through this upsert,
    // silently overwritten iteration one's record with iteration two's. The path
    // carries the iteration number, so each execution keeps its own row.
    where: { runId_path: { runId: args.runId, path: args.path } },
    create: {
      runId: args.runId,
      path: args.path,
      stepId: args.stepId,
      stepType: args.stepType,
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      completedAt: done ? new Date() : null,
    },
    update: {
      status: args.status,
      note: args.note,
      output: args.output as Prisma.InputJsonValue | undefined,
      // A top-level back-edge can re-run the same path days later. Without this
      // reset the recorded duration would include the wait in between.
      ...(args.status === "running" ? { startedAt: new Date(), completedAt: null } : {}),
      completedAt: done ? new Date() : null,
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
    select: { id: true, blockedByRunId: true },
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
  for (const run of blocked) {
    if (run.blockedByRunId && stillOpen.has(run.blockedByRunId)) continue;
    // Conditional on still being blocked: two sweeps can overlap, and only one
    // should hand the run to the processor.
    const { count } = await prisma.journeyRun.updateMany({
      where: { id: run.id, status: "blocked" },
      data: { status: "queued", nextRunAt: new Date(), blockedByRunId: null },
    });
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

async function processOneRun(runId: string, stop: StopSignal = NEVER_STOP) {
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

  // Shallow on purpose: this parse happens on EVERY tick for EVERY run, and
  // validating ten `choose` branches to execute one of them is work nobody asked
  // for. The branch actually entered is prepared and validated on entry, then
  // cached by immutable version id. See journeyScript.ts.
  const definition = parseJourneyDefinition(run.journeyVersion.definition, { deep: false });
  const lookup: ScriptLookup = { cache: journeyScriptCache(), versionId: run.journeyVersionId };

  let cursor = parseCursor(run.cursor, run.currentStepId);
  let context = run.context as unknown as JourneyContext;
  let stepsExecuted = run.stepsExecuted;
  /** The last position reached, so the catch blocks can log against it. */
  let position: CursorPosition | null = null;

  const park = async () =>
    prisma.journeyRun.update({
      where: { id: run.id },
      data: budgetStopUpdate(cursor.stepId, context as Prisma.InputJsonValue, {
        cursor: cursor as unknown as Prisma.InputJsonValue,
        stepsExecuted,
      }),
    });

  const finish = async (note: string) => {
    await prisma.journeyRun.update({
      where: { id: run.id },
      data: {
        status: "completed",
        currentStepId: null,
        cursor: Prisma.JsonNull,
        stepsExecuted,
        completedAt: new Date(),
        attempts: 0,
        context: context as Prisma.InputJsonValue,
      },
    });
    await logAudit({
      action: "journey.completed",
      summary: `Journey “${run.journey.name}” completed${note ? `: ${note}` : ""}`,
      leadId: run.leadId,
      contactId: run.contactId,
      userName: "Journey engine",
    });
    return true;
  };

  try {
    for (let count = 0; count < MAX_STEPS_PER_TICK; count++) {
      // Budget spent: park the run exactly where it is and RETURN.
      //
      // `break` here was wrong and actively harmful: falling out of the loop
      // used to land on an "exceeded MAX_STEPS_PER_TICK" throw, whose catch
      // marked the not-yet-executed step FAILED, incremented attempts, and after
      // MAX_RUN_ATTEMPTS budget stops failed the journey permanently. Running out
      // of time is not an error and must not consume a retry.
      //
      // The run was claimed as "running", so it has to be put back to "queued"
      // explicitly — leaving it running would strand it until the stale-run
      // recovery sweep. attempts is deliberately untouched: a budget stop is not
      // an attempt, and any genuine earlier failures keep their count.
      if (stop.shouldStop(STEP_RESERVE_MS)) {
        await park();
        return false;
      }

      position = resolveCursor(definition, cursor, lookup);
      if (!position) return finish("");
      const { step, path, keyPath } = position;
      const inSequence = cursor.frames.length > 0;
      // What the step sees: the run context plus the innermost loop's variables,
      // derived from the cursor rather than stored, because the context is
      // reloaded from the database after every step and would wipe them.
      const stepContext = withRepeatVars(context, cursor);

      if (stepsExecuted >= MAX_STEPS_PER_RUN) {
        throw new AbortJourney(`Journey exceeded ${MAX_STEPS_PER_RUN} steps in one run`);
      }
      stepsExecuted += 1;

      /* ── control-flow containers: the RUNNER runs these, not the executor ── */
      if (step.type === "choose" || step.type === "repeat") {
        let entered = null;
        if (step.type === "choose") {
          const picked = chooseBranch(step, keyPath, stepContext, lookup);
          entered = picked ? enterChoose(step, picked.option) : null;
        } else {
          entered = enterRepeat(step, keyPath, stepContext, lookup);
        }

        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "completed",
          note: entered
            ? entered.kind === "choose"
              ? `Chose branch ${entered.option}`
              : "Entered repeat"
            : step.type === "choose"
              ? "No branch matched"
              : "Repeat skipped: nothing to iterate",
          output: entered?.kind === "repeat" ? { items: entered.items?.length ?? null } : {},
        });

        cursor = entered
          ? pushFrame(cursor, entered)
          : advanceCursor({ definition, cursor, context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      /* ── leaf actions ─────────────────────────────────────────────────── */
      await updateStepLog({ runId: run.id, path, stepId: step.id, stepType: step.type, status: "running" });

      let result;
      try {
        result = await executeJourneyStep({
          step,
          context: stepContext,
          category: run.journey.category,
          journeyName: run.journey.name,
          runId: run.id,
          inSequence,
        });
      } catch (error) {
        // continueOnError, after HA's per-action flag. Control flow is NEVER
        // swallowed: a stop, a condition gate or an abort is a decision, and
        // treating it as a recoverable fault would run steps the author put
        // behind it.
        if (isControlFlow(error) || !step.continueOnError) throw error;
        const message = error instanceof Error ? error.message : "Step failed";
        await updateStepLog({
          runId: run.id,
          path,
          stepId: step.id,
          stepType: step.type,
          status: "failed",
          note: `Continued past error: ${message}`.slice(0, 1000),
        });
        cursor = advanceCursor({ definition, cursor, context: stepContext, lookup });
        await persistPosition(run.id, cursor, stepsExecuted, context);
        continue;
      }

      const nextTop = inSequence ? null : resolveTopLevelNext(step, result);
      await updateStepLog({
        runId: run.id,
        path,
        stepId: step.id,
        stepType: step.type,
        status: result.status === "skipped" ? "skipped" : "completed",
        note: result.note,
        output: {
          ...result.output,
          nextStepId: nextTop,
          nextRunAt: result.nextRunAt?.toISOString(),
        },
      });

      // A wait is a PARK, not an unwind — which is exactly why it stayed a
      // return value while stop/condition-fail became exceptions. The cursor is
      // advanced first, so the run resumes on the step AFTER the wait, possibly
      // days later and in another process.
      cursor = advanceCursor({
        definition,
        cursor,
        context: stepContext,
        lookup,
        ...(result.branch ? { override: result.branch.stepId } : {}),
      });

      if (result.status === "waiting") {
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "waiting",
            currentStepId: cursor.stepId,
            cursor: cursor as unknown as Prisma.InputJsonValue,
            stepsExecuted,
            nextRunAt: result.nextRunAt ?? new Date(Date.now() + 60_000),
            attempts: 0,
            context: context as Prisma.InputJsonValue,
          },
        });
        return true;
      }

      const refreshed = await loadJourneyContext(
        run.entityType as JourneyEntityType,
        run.entityId,
        (context.event ?? {}) as Record<string, unknown>
      );
      if (refreshed) context = refreshed;
      await persistPosition(run.id, cursor, stepsExecuted, context);
    }

    // Out of per-tick steps. This used to THROW, which was defensible when
    // twenty immediate steps could only mean a runaway definition — it cannot
    // mean that any more, because a `repeat` of forty passes reaches twenty
    // legitimately. Park and pick it up next tick; MAX_STEPS_PER_RUN is what
    // catches a run that genuinely never ends.
    await park();
    return false;
  } catch (error) {
    /* ── deliberate control flow: not faults, never retried ──────────────── */
    if (error instanceof StopJourney || error instanceof ConditionFailed) {
      if (position) {
        await updateStepLog({
          runId: run.id,
          path: position.path,
          stepId: position.step.id,
          stepType: position.step.type,
          status: "completed",
          note: error.message.slice(0, 1000),
          output: { stopped: true, reason: error instanceof ConditionFailed ? "condition" : "stop" },
        });
      }
      return finish(error.message);
    }

    const abort = error instanceof AbortJourney;
    const message = error instanceof Error ? error.message : "Unknown journey run error";
    if (position) {
      await updateStepLog({
        runId: run.id,
        path: position.path,
        stepId: position.step.id,
        stepType: position.step.type,
        status: "failed",
        note: message.slice(0, 1000),
      });
    }
    // An abort is deterministic — a loop that will not terminate, a cursor that
    // no longer matches its definition, an author-declared error stop. Retrying
    // it three times fails three times and burns the budget doing it.
    const attempts = abort ? MAX_RUN_ATTEMPTS : run.attempts + 1;
    const retry = !abort && attempts < MAX_RUN_ATTEMPTS;
    await prisma.journeyRun.update({
      where: { id: run.id },
      data: {
        status: retry ? "queued" : "failed",
        attempts,
        stepsExecuted,
        nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
        lastError: message.slice(0, 1000),
      },
    });
    return false;
  }
}

/**
 * The run's durable position after a step.
 *
 * `currentStepId` keeps carrying the TOP-LEVEL step so existing screens and
 * queries still read correctly; `cursor` carries the frames that say where
 * inside a container the run actually is. A run parked here can be resumed by
 * any process, from these two columns and the pinned (immutable) version alone.
 */
async function persistPosition(
  runId: string,
  cursor: JourneyCursor,
  stepsExecuted: number,
  context: JourneyContext,
) {
  await prisma.journeyRun.update({
    where: { id: runId },
    data: {
      currentStepId: cursor.stepId,
      cursor: cursor as unknown as Prisma.InputJsonValue,
      stepsExecuted,
      attempts: 0,
      context: context as Prisma.InputJsonValue,
    },
  });
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
