"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireTenantOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { asActionResult, refuse } from "@/lib/actionResult";
import { SIGNING_DEFAULT_WORKFLOW_KEY, defaultSignWorkflowId } from "@/lib/signflow/defaultWorkflow";

/**
 * Make a workflow the one every quote starts on, or go back to none.
 *
 * Owner-only, like designing a workflow: this decides whether a quote goes
 * through an approval at all unless somebody remembers to ask for one. Audited,
 * so "who stopped quotes going to the manager?" has an answer.
 *
 * `workflowId` empty clears it. The id comes from a button on the settings
 * page, so it is looked up here rather than trusted: it has to be a workflow of
 * this workspace that can still be offered.
 */
export async function setDefaultSignWorkflow(workflowId: string) {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const before = await defaultSignWorkflowId();

    if (!workflowId) {
      await putSetting(SIGNING_DEFAULT_WORKFLOW_KEY, "");
      await logAudit({
        action: "signflow.default_cleared",
        summary: "Quotes no longer start on a signing workflow — the built-in flow is the default again",
        entityType: "AppSetting",
        entityId: SIGNING_DEFAULT_WORKFLOW_KEY,
        userName: user.name,
        metadata: { before },
      });
      revalidatePath("/settings/signing-workflows");
      return { success: "Quotes go back to the built-in flow unless a workflow is chosen" };
    }

    const workflow = await prisma.signWorkflow.findFirst({
      where: { id: workflowId, isArchived: false, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!workflow) refuse("That workflow is no longer there — refresh the page.");
    await putSetting(SIGNING_DEFAULT_WORKFLOW_KEY, workflow.id);
    await logAudit({
      action: "signflow.default_set",
      summary: `Every quote now starts on the signing workflow “${workflow.name}”`,
      entityType: "SignWorkflow",
      entityId: workflow.id,
      userName: user.name,
      metadata: { before },
    });
    revalidatePath("/settings/signing-workflows");
    return { success: `Every quote now starts on “${workflow.name}”` };
  });
}
