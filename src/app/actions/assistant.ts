"use server";

import { requireAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { askCrm, type AssistantResult } from "@/lib/crmAssistant";

const ASSISTANT_PERMISSIONS = [
  "leads.view_all", "leads.view_owned",
  "quotes.view_all", "quotes.view_owned",
  "activities.view", "activities.manage",
] as const;

/** One question in, one answer out. Read-only: nothing here writes a record. */
export async function askCrmAction(question: string): Promise<AssistantResult> {
  return withActingStaffScope(async () => {
    const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
    // The page hides it with the module off; the action must refuse on its own.
    if (!(await isModuleEnabled("automation"))) {
      return { ok: false, error: "Ask the CRM is part of the Automation & AI module, which is off for this workspace." };
    }
    const q = String(question ?? "").trim().slice(0, 500);
    if (!q) return { ok: false, error: "Type a question first." };
    return askCrm(user, q);
  });
}
