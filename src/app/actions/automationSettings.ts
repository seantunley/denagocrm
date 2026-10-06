"use server";

import { revalidatePath } from "next/cache";
import { requireTenantOwner } from "@/lib/auth";
import { putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";
import { AUTOMATIONS } from "@/lib/automationRegister";
import { automationOn } from "@/lib/automationSwitch";
import { actingTenantId } from "@/lib/actingTenant";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { ensureReadyMadeJourneysQuietly, readyMadeJourneyStates } from "@/lib/readyMadeJourneys";

export type ReadyMadeJourneyRow = {
  key: string;
  name: string;
  description: string;
  channels: string[];
  messages: string[];
  journeyId: string | null;
  /** active | paused | draft | archived — null when it was deleted. */
  status: string | null;
};

/**
 * The ready-made journeys that send this workspace's automatic customer messages,
 * and whether each is on — creating any that don't exist yet (off, unless the old
 * built-in was switched on). Owner-only. `marketingOn`: journeys only run with the
 * Marketing pack, so the page says so when it is off.
 */
export async function readReadyMadeJourneys(): Promise<{ rows: ReadyMadeJourneyRow[]; marketingOn: boolean }> {
  return withActingStaffScope(async () => {
    await requireTenantOwner();
    const tenantId = await actingTenantId();
    await ensureReadyMadeJourneysQuietly(tenantId);
    const [states, marketingOn] = await Promise.all([
      readyMadeJourneyStates(tenantId),
      isModuleEnabled("marketing").catch(() => true),
    ]);
    const rows = states.map(({ def, journeyId, status }) => ({
      key: def.key,
      name: def.name,
      description: def.description,
      channels: def.channels,
      messages: def.messages,
      journeyId,
      status,
    }));
    return { rows, marketingOn };
  });
}

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
