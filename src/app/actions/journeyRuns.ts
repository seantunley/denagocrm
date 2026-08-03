"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  emitJourneyEvent,
  enrollJourneyNow,
  processJourneyEventById,
  processJourneyEvents,
  processJourneyRuns,
  processOneRun,
} from "@/lib/journeys";
import { OPEN_RUN_STATUSES, parseRunMode } from "@/lib/journeyArbitration";

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
  const event = await emitJourneyEvent({
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
  if (!event) return { ok: false as const, error: "Could not emit the test event. Try again." };

  // THIS event and THIS run — nothing else.
  //
  // The previous version called processJourneyEvents(100) and
  // processJourneyRuns(50), which are workspace-wide: pressing "test" drove up
  // to fifty unrelated due runs and really sent their messages. And if the
  // backlog was bigger than those limits, the test's own run could still be
  // pending while this action returned success — the operator sees "ran" and
  // waits for a message that has not been attempted.
  const processed = await processJourneyEventById(event.id);
  const mine = processed.decisions.find((decision) => decision.journeyId === journeyId);
  if (!mine?.enrolled) {
    return {
      ok: false as const,
      error: `Not enrolled: ${mine?.reason ?? "the journey did not consider this event"}`,
    };
  }

  const run = await prisma.journeyRun.findFirst({
    where: { journeyId, entityType: "lead", entityId: lead.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true },
  });
  if (!run) return { ok: false as const, error: "Enrolled, but the run could not be found." };

  // A run parked by run mode "queued" must NOT be driven here — it is waiting
  // for its predecessor on purpose, and forcing it would defeat the mode.
  if (run.status !== "blocked") await processOneRun(run.id);
  const after = await prisma.journeyRun.findUnique({
    where: { id: run.id },
    select: { status: true, lastError: true },
  });

  await logAudit({
    action: "journey.manual_run",
    summary: `Ran journey “${journey.name}” manually against lead “${lead.title}” — ${after?.status ?? "unknown"}`,
    leadId: lead.id,
    contactId: lead.contactId,
    user,
  });
  revalidatePath("/journeys");
  revalidatePath("/journeys/activity");
  return {
    ok: true as const,
    runId: run.id,
    status: after?.status ?? run.status,
    error: after?.lastError ?? null,
  };
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

  // Retrying must not resurrect a run its own journey has already replaced.
  //
  // Run mode `restart` cancels the open run and starts a fresh one. The
  // cancelled row then sits in the list with a "Retry" button, and pressing it
  // put the superseded sequence back in the queue beside its replacement —
  // two live sequences for one person, on the mode whose whole purpose is to
  // prevent exactly that. The same applies to `single` and `queued`.
  const mode = parseRunMode(run.journey.runMode);
  if (mode !== "parallel") {
    const open = await prisma.journeyRun.count({
      where: {
        journeyId: run.journeyId,
        entityType: run.entityType,
        entityId: run.entityId,
        status: { in: OPEN_RUN_STATUSES },
      },
    });
    if (open > 0) {
      throw new Error(
        `This run was superseded — ${run.journey.name} already has a newer run open for this ${run.entityType}. Cancel that one first if you want this one back.`,
      );
    }
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
