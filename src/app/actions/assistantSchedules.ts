"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { MAX_ACTIVE_SCHEDULES, describeSchedule, nextRun } from "@/lib/assistantSchedule";
import { withScheduleSlot } from "@/lib/assistantScheduleRun";
import { ownedWriteTenantId } from "@/lib/tenantWrite";

/*
 * A person managing their OWN scheduled questions on the Ask page: pause,
 * resume, delete. Every lookup and write is keyed on the schedule id AND the
 * signed-in user's id AND the workspace they're acting in, so someone else's
 * id — even in the same workspace — is simply not found. Same gate as asking: an assistant permission and the
 * Automation & AI module.
 */

const GONE = "That scheduled question is no longer there — refresh the page.";

async function gate() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

/** The caller's own schedule, in the workspace they're acting in — or a refusal. */
async function ownSchedule(id: string, userId: string) {
  const schedule = await prisma.assistantSchedule.findFirst({
    where: { id: String(id), userId, tenantId: ownedWriteTenantId() },
    select: { id: true, tenantId: true, cadence: true, weekday: true, timeOfDay: true, onDate: true, active: true },
  });
  if (!schedule) refuse(GONE);
  return schedule;
}

export async function setAssistantScheduleActive(id: string, active: boolean) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const schedule = await ownSchedule(id, user.id);
      if (schedule.active === Boolean(active)) return { success: active ? "Already running" : "Already paused" };
      if (!active) {
        await prisma.assistantSchedule.updateMany({ where: { id: schedule.id, tenantId: schedule.tenantId, userId: user.id }, data: { active: false, nextRunAt: null } });
      } else {
        // From NOW: a paused schedule never makes up the runs it missed.
        const nextRunAt = nextRun(schedule, new Date());
        if (!nextRunAt) refuse("That one-off time has passed — ask for a new one instead.");
        const resumed = await withScheduleSlot(user.id, (tx) =>
          tx.assistantSchedule.updateMany({ where: { id: schedule.id, tenantId: schedule.tenantId, userId: user.id }, data: { active: true, nextRunAt } }),
        );
        if (!resumed) refuse(`You already have ${MAX_ACTIVE_SCHEDULES} scheduled questions running — pause or delete one first.`);
      }
      await logAudit({
        action: active ? "assistant.schedule_resumed" : "assistant.schedule_paused",
        summary: `${active ? "Resumed" : "Paused"} a scheduled assistant question (${describeSchedule(schedule)})`,
        user, entityType: "AssistantSchedule", entityId: schedule.id,
      });
      revalidatePath("/assistant");
      return { success: active ? "Resumed" : "Paused" };
    }),
  );
}

export async function deleteAssistantSchedule(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const schedule = await ownSchedule(id, user.id);
      // Its past answers stay in the person's history; only the schedule goes.
      await prisma.assistantSchedule.deleteMany({ where: { id: schedule.id, tenantId: schedule.tenantId, userId: user.id } });
      await logAudit({
        action: "assistant.schedule_deleted",
        summary: `Deleted a scheduled assistant question (${describeSchedule(schedule)})`,
        user, entityType: "AssistantSchedule", entityId: schedule.id,
      });
      revalidatePath("/assistant");
      return { success: "Deleted" };
    }),
  );
}
