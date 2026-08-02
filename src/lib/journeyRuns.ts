import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { executeJourneyStep } from "./journeyStepExecutor";
import { loadJourneyContext, type JourneyEntityType, type JourneyContext } from "./journeyContext";
import { parseJourneyDefinition, stepById } from "./journeyTypes";
import { NEVER_STOP, type StopSignal } from "./stopSignal";
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

  const definition = parseJourneyDefinition(run.journeyVersion.definition);
  let currentStepId = run.currentStepId;
  let context = run.context as unknown as JourneyContext;
  const visited = new Set<string>();

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
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: budgetStopUpdate(currentStepId, context as Prisma.InputJsonValue),
        });
        return false;
      }
      const step = stepById(definition, currentStepId);
      if (!step) {
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "completed",
            currentStepId: null,
            completedAt: new Date(),
            attempts: 0,
            context: context as Prisma.InputJsonValue,
          },
        });
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
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "waiting",
            currentStepId: nextStepId,
            nextRunAt: result.nextRunAt ?? new Date(Date.now() + 60_000),
            attempts: 0,
            context: context as Prisma.InputJsonValue,
          },
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
      await prisma.journeyRun.update({
        where: { id: run.id },
        data: { currentStepId, attempts: 0, context: context as Prisma.InputJsonValue },
      });
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
    await prisma.journeyRun.update({
      where: { id: run.id },
      data: {
        status: retry ? "queued" : "failed",
        attempts,
        nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
        lastError: message.slice(0, 1000),
      },
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
