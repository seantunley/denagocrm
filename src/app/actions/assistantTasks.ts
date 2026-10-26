"use server";

import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse } from "@/lib/actionResult";
import { logAudit } from "@/lib/audit";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { setTaskStatus } from "@/lib/assistantTask";

/*
 * A person closing or reopening their OWN job sheet on the Ask page (nothing
 * hidden: everything DAX holds is shown there and can be closed). Keyed on the
 * sheet id AND the signed-in person AND the workspace they act in, under the
 * sheet's row lock (assistantTask.setTaskStatus) — someone else's id is simply
 * not found. Audit summaries name the kind only: a sheet's title names a customer.
 */

const GONE = "That job sheet is no longer there — refresh the page.";

async function gate() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("The assistant is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

export async function setAssistantTaskOpen(id: string, open: boolean) {
  return asActionResult(() =>
    withActingStaffScope(async () => {
      const user = await gate();
      const task = await setTaskStatus(user.id, String(id), open ? "open" : "closed");
      if (!task) refuse(GONE);
      await logAudit({
        action: open ? "assistant.task_reopened" : "assistant.task_closed",
        summary: `${open ? "Reopened" : "Closed"} an assistant job sheet (${task.kind})`,
        user, entityType: "AssistantTask", entityId: String(id),
      });
      revalidatePath("/assistant");
      return { success: open ? "Reopened" : "Closed" };
    }),
  );
}
