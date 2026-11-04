"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireTenantOwner } from "@/lib/auth";
import { getSetting, putSetting } from "@/lib/settings";
import { logAudit } from "@/lib/audit";
import { FLOW_SHARED_VALUES_KEY, SHARED_VALUE_LIMIT, parseSharedValues, sharedNameProblem, type SharedValue } from "@/lib/flowSharedValues";

/** Flows → Shared values (lib/flowSharedValues.ts). Owner only; every change is logged. */
const PAGE = "/bot-builder/values";
const clean = (value: FormDataEntryValue | null) => String(value ?? "").replace(/\r\n/g, "\n").trim().slice(0, 500);

async function save(list: SharedValue[]) {
  await putSetting(FLOW_SHARED_VALUES_KEY, JSON.stringify(list));
  revalidatePath(PAGE);
  revalidatePath("/bot-builder");
}

export async function addSharedValue(formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const name = String(formData.get("name") ?? "").trim().toLowerCase();
    const value = clean(formData.get("value"));
    const list = parseSharedValues(await getSetting(FLOW_SHARED_VALUES_KEY));
    const problem = sharedNameProblem(name, list.map((v) => v.name));
    if (problem) refuse(problem);
    if (!value) refuse("Give it a value, e.g. 021 555 0100.");
    if (list.length >= SHARED_VALUE_LIMIT) refuse(`Up to ${SHARED_VALUE_LIMIT} shared values.`);
    await save([...list, { name, value }]);
    await logAudit({ action: "bot.shared_value_added", summary: `Shared value {{${name}}} added for chatbot flows`, user });
    return { success: `{{${name}}} saved` };
  });
}

export async function updateSharedValue(name: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const value = clean(formData.get("value"));
    if (!value) refuse("A shared value can't be empty — delete it instead.");
    const list = parseSharedValues(await getSetting(FLOW_SHARED_VALUES_KEY));
    if (!list.some((v) => v.name === name)) refuse("That shared value no longer exists.");
    await save(list.map((v) => (v.name === name ? { name, value } : v)));
    await logAudit({ action: "bot.shared_value_changed", summary: `Shared value {{${name}}} changed — every flow uses the new value from the next message`, user });
    return { success: `{{${name}}} updated in every flow` };
  });
}

export async function deleteSharedValue(name: string): Promise<ActionResult> {
  return asActionResult(async () => {
    const user = await requireTenantOwner();
    const list = parseSharedValues(await getSetting(FLOW_SHARED_VALUES_KEY));
    if (!list.some((v) => v.name === name)) return { success: "Already removed" };
    await save(list.filter((v) => v.name !== name));
    await logAudit({ action: "bot.shared_value_deleted", summary: `Shared value {{${name}}} deleted — messages that use it now show it blank`, user });
    return { success: `{{${name}}} deleted` };
  });
}
