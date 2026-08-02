"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  emitJourneyEvent,
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

/**
 * Run a journey against ONE chosen lead, now.
 *
 * After Home Assistant's "Run actions", and for the same reason: testing a
 * journey otherwise means waiting for the real event to happen to a real
 * customer, so the usual method is to enrol yourself and hope the copy is
 * right. This drives the genuine path — same emit, same entry conditions, same
 * run mode, same steps — against a lead you pick.
 *
 * It is deliberately NOT a dry run. A dry run that skips the sends proves the
 * journey walks, which is the half that rarely breaks; the half that breaks is
 * the message, the merge fields and the consent gate, and only a real send
 * exercises those. So this genuinely sends, and says so at the call site.
 */
export async function runJourneyOnLead(journeyId: string, leadId: string) {
  const user = await requireOwner();
  const [journey, lead] = await Promise.all([
    prisma.journey.findUniqueOrThrow({ where: { id: journeyId }, select: { id: true, name: true, status: true } }),
    prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { id: true, title: true, contactId: true } }),
  ]);
  if (journey.status !== "active") {
    return { ok: false as const, error: "Activate the journey first — a paused journey enrols nobody." };
  }

  // A distinct dedupe key per manual run, or the second test on the same lead
  // would be swallowed as "already seen" and look like the journey ignoring it.
  // Date.now() is fine here: this is an operator action, not a replayed event.
  await emitJourneyEvent({
    type: (await activeTriggerFor(journeyId)) ?? "lead_created",
    entityType: "lead",
    entityId: lead.id,
    payload: { manual: true, byUserId: user.id },
    dedupeKey: `manual:${journeyId}:${lead.id}:${Date.now()}`,
    // Scope the event to THIS journey. A broadcast would enrol the lead into
    // every other active journey listening for the same trigger, which is a
    // surprising amount of mail to send by pressing "test".
    journeyId,
  });
  await processJourneyEvents(100);
  await processJourneyRuns(50);

  await logAudit({
    action: "journey.manual_run",
    summary: `Ran journey “${journey.name}” manually against lead “${lead.title}”`,
    leadId: lead.id,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/journeys");
  revalidatePath("/journeys/activity");
  return { ok: true as const };
}

/** The trigger the journey's published version listens for. */
async function activeTriggerFor(journeyId: string): Promise<string | null> {
  const journey = await prisma.journey.findUnique({
    where: { id: journeyId },
    select: { activeVersion: true, versions: { where: { state: "published" }, select: { version: true, trigger: true } } },
  });
  if (!journey) return null;
  const active = journey.versions.find((version) => version.version === journey.activeVersion);
  return active?.trigger ?? journey.versions[0]?.trigger ?? null;
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
