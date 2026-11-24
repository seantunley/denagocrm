"use server";

import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { asActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { requireTenantOwner } from "@/lib/auth";
import { putWorkspaceSetting } from "@/lib/settings";
import { REGIONS_KEY, REGION_LABEL_KEY, cleanRegionLabel, parseRegions } from "@/lib/regionRules";

/** The workspace's regions (one per line) and their name. Workspace owner, like the other Settings lists. */
export async function saveRegions(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      const list = parseRegions(String(formData.get("regions") ?? ""));
      const label = cleanRegionLabel(formData.get("label"));
      await putWorkspaceSetting(tenantId, REGIONS_KEY, list.join("\n"));
      await putWorkspaceSetting(tenantId, REGION_LABEL_KEY, label);
      await logAudit({ action: "settings.regions", summary: `${label || "Regions"}: ${list.join(", ") || "standard list"}`, user });
      revalidatePath("/settings");
      return { success: "Regions saved" };
    }),
  );
}
