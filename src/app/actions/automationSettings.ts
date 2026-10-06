"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { AUTOMATIONS } from "@/lib/automationRegister";
import { automationOn } from "@/lib/automationSwitch";

/** Every switch on the page, as it stands for this workspace. Owner-only. */
export async function readAutomationSwitches(): Promise<Record<string, boolean>> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const keys = AUTOMATIONS.flatMap((a) => (a.setting ? [a.setting.key] : []));
    const values = await Promise.all(keys.map((key) => automationOn(key).catch(() => false)));
    return Object.fromEntries(keys.map((key, i) => [key, values[i]]));
  });
}

/**
 * Switch one automation on or off. Only a switch that is on the page (the
 * register) — a posted key can't set an arbitrary setting. Owner-only and
 * audited: these decide whether the CRM contacts customers by itself.
 */
export async function saveAutomationSwitch(
  _prev: { error?: string; ok?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  return withActingStaffScope(async () => {
    const user = await requireTenantOwner();
    const key = String(formData.get("key") ?? "");
    const automation = AUTOMATIONS.find((a) => a.setting?.key === key);
    if (!automation?.setting) return { error: "That isn't a switch on this page." };
    const on = formData.get("on") === "on";
    const before = await automationOn(key).catch(() => automation.setting!.defaultOn);
    await putSetting(key, on ? "true" : "false");
    if (before !== on) {
      await logAudit({
        action: "automation.switched",
        summary: `${automation.label} switched ${on ? "on" : "off"}${automation.reaches === "customer" ? " (messages customers)" : ""}`,
        entityType: "AppSetting",
        entityId: key,
        userName: user.name,
        metadata: { automation: automation.key, before, after: on },
      });
    }
    revalidatePath("/settings/automatic");
    return { ok: on ? "On" : "Off" };
  });
}
