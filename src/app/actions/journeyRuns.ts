"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

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
  if (!["queued", "waiting", "running"].includes(run.status)) {
    throw new Error("This journey run can no longer be cancelled");
  }

  await prisma.journeyRun.update({
    where: { id: runId },
    data: {
      status: "cancelled",
      completedAt: new Date(),
      lastError: "Cancelled by an administrator",
    },
  });
  await logAudit({
    action: "journey.run_cancelled",
    summary: `Cancelled journey “${run.journey.name}” run ${run.id.slice(-8)}`,
    leadId: run.leadId,
    contactId: run.contactId,
    user,
  });
  revalidatePath("/journeys");
}
