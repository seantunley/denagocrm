"use server";

import { revalidatePath } from "next/cache";
import { requireAnyPermission } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ASSISTANT_PERMISSIONS } from "@/lib/assistantUser";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { prepareTriage, runTriage, sendTriageDraft } from "@/lib/assistantTriage";

/** The same gate as Ask DAX: the assistant's permissions, and the Automation & AI module on. */
async function triageUser() {
  const user = await requireAnyPermission(...ASSISTANT_PERMISSIONS);
  if (!(await isModuleEnabled("automation"))) refuse("Triage is part of the Automation & AI module, which is off for this workspace.");
  return user;
}

/** Ask DAX to go through the deals waiting on you and prepare what to do. Nothing is done until you approve it. */
export async function prepareTriageAction(): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await triageUser();
    const result = await prepareTriage(user);
    if (!result.ok) refuse(result.error);
    revalidatePath("/assistant/triage");
    return { success: `Prepared ${result.deals} deal${result.deals === 1 ? "" : "s"} — tick what to do` };
  });
}

/** Do the ticked tasks (never a message: those have their own Send). */
export async function runTriageAction(taskId: string, cardIds: string[]): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await triageUser();
    if (!cardIds.length) refuse("Tick at least one task to do.");
    const counts = await runTriage(user, taskId, cardIds.slice(0, 50));
    revalidatePath("/assistant/triage");
    if (!counts.ok) refuse(counts.error);
    const parts = [`${counts.done} done`];
    if (counts.failed) parts.push(`${counts.failed} refused (nothing changed — see why)`);
    if (counts.unsure) parts.push(`${counts.unsure} may have got part-way — check those deals`);
    return { success: parts.join(", ") };
  });
}

/** Send one drafted message, as edited, from its own Send button. */
export async function sendTriageDraftAction(taskId: string, cardId: string, body: string, subject?: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await triageUser();
    if (!body.trim()) refuse("The message is empty.");
    const result = await sendTriageDraft(user, taskId, cardId, body, subject);
    revalidatePath("/assistant/triage");
    if (!result.ok) refuse(result.error ?? "It wasn't sent.");
    return { success: result.success ?? "Sent" };
  });
}
