import { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { logAudit } from "./audit";
import { executeJourneyStep } from "./journeyStepExecutor";
import { loadJourneyContext, type JourneyEntityType, type JourneyContext } from "./journeyContext";
import { parseJourneyDefinition, stepById } from "./journeyTypes";

const MAX_RUN_ATTEMPTS = 3;
const MAX_STEPS_PER_TICK = 20;

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

export async function recoverStaleJourneyRuns() {
  const cutoff = new Date(Date.now() - 15 * 60_000);
  return prisma.journeyRun.updateMany({
    where: { status: "running", updatedAt: { lt: cutoff } },
    data: { status: "queued", nextRunAt: new Date(), lastError: "Recovered stale running journey" },
  });
}

async function processOneRun(runId: string) {
  const run = await prisma.journeyRun.findUnique({
    where: { id: runId },
    include: { journey: true, journeyVersion: true },
  });
  if (!run || !["queued", "waiting"].includes(run.status)) return false;

  const claimed = await prisma.journeyRun.updateMany({
    where: { id: run.id, status: { in: ["queued", "waiting"] }, nextRunAt: { lte: new Date() } },
    data: {
      status: "running",
      attempts: { increment: 1 },
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
      const step = stepById(definition, currentStepId);
      if (!step) {
        await prisma.journeyRun.update({
          where: { id: run.id },
          data: {
            status: "completed",
            currentStepId: null,
            completedAt: new Date(),
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
        data: { currentStepId, context: context as Prisma.InputJsonValue },
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
    const retry = run.attempts + 1 < MAX_RUN_ATTEMPTS;
    await prisma.journeyRun.update({
      where: { id: run.id },
      data: {
        status: retry ? "queued" : "failed",
        nextRunAt: retry ? new Date(Date.now() + 5 * 60_000) : run.nextRunAt,
        lastError: message.slice(0, 1000),
      },
    });
    return false;
  }
}

export async function processJourneyRuns(limit = 40) {
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
  for (const run of runs) if (await processOneRun(run.id)) processed++;
  return processed;
}
