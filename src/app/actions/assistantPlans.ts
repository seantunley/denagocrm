"use server";

import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { continuePlan } from "@/lib/assistantPlan";
import type { PlanView } from "@/lib/assistantPlanRules";
import { runAssistantAction } from "@/app/actions/assistant";

/**
 * Confirm — and Retry — on a multi-step plan: runs its steps in order from the
 * first not done (assistantPlan.continuePlan). The browser names the plan and
 * nothing else: the steps are the ones the server stored when DAX proposed it,
 * found by the signed-in person's own id in the workspace they act in. Each step
 * runs through its card's own action (runAssistantAction), with that action's
 * permission check, stage gates, clash checks and audit entry. A message to a
 * customer is never a step — it has its own Send.
 */
export async function runAssistantPlan(taskId: string): Promise<{ ok: boolean; message: string; plan: PlanView | null }> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, message: "Ask the CRM is part of the Automation & AI module, which is off for this workspace.", plan: null };
    }
    const result = await continuePlan(user, String(taskId ?? ""), (card) => runAssistantAction(card));
    if (result.plan) {
      // Each step wrote its own audit entry; this one records that they ran as one plan. The kind only — a title names a customer.
      await logAudit({ action: "assistant.plan_run", summary: `Ran an assistant plan (${result.plan.status}, ${result.plan.steps.filter((s) => s.status === "done").length} of ${result.plan.steps.length} steps done)`, user, entityType: "AssistantTask", entityId: result.plan.taskId });
      revalidatePath("/assistant");
    }
    return result;
  });
}
