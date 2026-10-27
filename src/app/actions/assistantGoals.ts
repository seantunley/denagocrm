"use server";

import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { closeGoal, setGoalPaused, startDeliveryGoal } from "@/lib/assistantGoals";

/*
 * A person's delivery goals on the Ask page (roadmap Phase 4b): start one ("keep an eye on this delivery"),
 * switch it Off or On, Close it. Keyed on the goal id AND the signed-in person AND the workspace they act in,
 * under the goal's row lock (lib/assistantGoals.ts) — someone else's id is simply not found. Audit summaries
 * name the kind only: a goal's title names a customer.
 */

const GONE = "That goal is no longer there — refresh the page.";

async function gate() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

export async function startDeliveryGoalAction(formData: FormData) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const result = await startDeliveryGoal(user, String(formData.get("quote") ?? ""));
      if (!result.ok) refuse(result.error);
      revalidatePath("/assistant");
      return { success: result.existing ? `Already following it. ${result.next}.` : `Following it. ${result.next}.` };
    }),
  );
}

export async function setDeliveryGoalOn(id: string, on: boolean) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      if (!(await setGoalPaused(user.id, String(id), !on))) refuse(GONE);
      await logAudit({ action: on ? "assistant.goal_on" : "assistant.goal_off", summary: `Switched ${on ? "on" : "off"} a delivery the assistant follows`, user, entityType: "AssistantTask", entityId: String(id) });
      revalidatePath("/assistant");
      return { success: on ? "On" : "Off" };
    }),
  );
}

export async function closeDeliveryGoal(id: string) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      if (!(await closeGoal(user.id, String(id)))) refuse(GONE);
      await logAudit({ action: "assistant.goal_closed", summary: "Closed a delivery the assistant was following", user, entityType: "AssistantTask", entityId: String(id) });
      revalidatePath("/assistant");
      return { success: "Closed" };
    }),
  );
}
