"use server";

import { revalidatePath } from "next/cache";
import { logAudit } from "@/lib/audit";
import { asActionResult } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { requireTenantOwner } from "@/lib/auth";
import { putWorkspaceSetting } from "@/lib/settings";
import { DEAL_LIFECYCLE_KEY, LIFECYCLE_TEMPLATES, lifecycleTemplate } from "@/lib/dealLifecycle";

/** The workspace's way of selling (brief §5). Workspace owner, like the other Company settings. */
export async function saveDealLifecycle(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await actingTenantId();
      const template = lifecycleTemplate(String(formData.get("template") ?? ""));
      await putWorkspaceSetting(tenantId, DEAL_LIFECYCLE_KEY, template);
      await logAudit({ action: "settings.deal_lifecycle", summary: `Deal steps: ${LIFECYCLE_TEMPLATES[template].name}`, user });
      revalidatePath("/settings/company");
      revalidatePath("/deals");
      return { success: "Deal steps saved" };
    }),
  );
}
