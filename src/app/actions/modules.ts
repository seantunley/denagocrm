"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { setEnabledModuleIds } from "@/lib/modules/enabled";
import { OPTIONAL_MODULE_IDS } from "@/lib/modules/registry";
import { logAudit } from "@/lib/audit";
import { withActingStaffScope } from "@/lib/actingScope";

/** Owner-only: save which optional feature packs are enabled for this install. */
export async function saveEnabledModules(formData: FormData) {
  return withActingStaffScope(async () => {
    const user = await requireOwner();
    const picked = formData.getAll("modules").map(String);
    const enabled = OPTIONAL_MODULE_IDS.filter((id) => picked.includes(id));
    // Which packs the form OFFERED, so a grant that changed between render and
    // submit cannot turn this post's silence about a pack into a decision about
    // it. Validated against the live grant inside setEnabledModuleIds, so this
    // claim can only narrow what the save touches.
    const rendered = String(formData.get("rendered") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    await setEnabledModuleIds(enabled, formData.has("rendered") ? rendered : null);
    await logAudit({
      action: "modules.updated",
      summary: `Enabled feature packs: ${["core", ...enabled].join(", ")}`,
      user,
    });
    // Nav, command palette and gating all read this — refresh the whole app shell.
    revalidatePath("/", "layout");
  });
}
