"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  enrollJourneyNow,
  processJourneyEvents,
  processJourneyRuns,
} from "@/lib/journeys";

export async function runJourneyNowAction(journeyId: string) {
  await requireOwner();
  await enrollJourneyNow(journeyId);
  await processJourneyEvents(100);
  await processJourneyRuns(50);
  revalidatePath("/journeys");
}

export async function retryJourneyRun(runId: string) {
  const user = await requireOwner();
  const run = await prisma.journeyRun.findUniqueOrThrow({
    where: { id: runId },
    include: { journey: true },
  });
  if (!["failed", "cancelled"].includes(run.status)) {
    throw new Error("Only failed or cancelled journey runs can be retried");
  }

  await prisma.$transaction([
    prisma.journeyStepLog.deleteMany({
      where: { runId, status: { in: ["running", "failed"] } },
    }),
    prisma.journeyRun.update({
      where: { id: runId },
      data: {
        status: "queued",
        attempts: 0,
        lastError: null,
        nextRunAt: new Date(),
        completedAt: null,
      },
    }),
  ]);
  await logAudit({
    action: "journey.run_retried",
    summary: `Retried journey “${run.journey.name}” run ${run.id.slice(-8)}`,
    leadId: run.leadId,
    contactId: run.contactId,
    user,
  });
  revalidatePath("/journeys");
}

export async function cancelJourneyRun(runId: string) {
  const user = await requireOwner();
  const run = await prisma.journeyRun.findUniqueOrThrow({
    where: { id: runId },
    include: { journey: true },
  });
  if (!["queued", "waiting"].includes(run.status)) {
    throw new Error("Only queued or waiting journey runs can be cancelled safely");
  }

  const cancelled = await prisma.journeyRun.updateMany({
    where: { id: runId, status: { in: ["queued", "waiting"] } },
    data: {
      status: "cancelled",
      completedAt: new Date(),
      lastError: "Cancelled by an administrator",
    },
  });
  if (cancelled.count === 0) throw new Error("The journey run started before it could be cancelled");

  await logAudit({
    action: "journey.run_cancelled",
    summary: `Cancelled journey “${run.journey.name}” run ${run.id.slice(-8)}`,
    leadId: run.leadId,
    contactId: run.contactId,
    user,
  });
  revalidatePath("/journeys");
}
