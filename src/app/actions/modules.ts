"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { setEnabledModuleIds } from "@/lib/modules/enabled";
import { OPTIONAL_MODULE_IDS } from "@/lib/modules/registry";
import { logAudit } from "@/lib/audit";

/** Owner-only: save which optional feature packs are enabled for this install. */
export async function saveEnabledModules(formData: FormData) {
  const user = await requireOwner();
  const picked = formData.getAll("modules").map(String);
  const enabled = OPTIONAL_MODULE_IDS.filter((id) => picked.includes(id));
  await setEnabledModuleIds(enabled);
  await logAudit({
    action: "modules.updated",
    summary: `Enabled feature packs: ${["core", ...enabled].join(", ")}`,
    user,
  });
  // Nav, command palette and gating all read this — refresh the whole app shell.
  revalidatePath("/", "layout");
}
