"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { connectMetaPage, disconnectMetaPage } from "@/lib/metaConnect";

/** Connect Facebook: the owner picks which of their Pages this workspace uses (lib/metaConnect.ts). */
export async function selectMetaPage(formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await getActiveTenantId();
      if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
      const pageId = String(formData.get("pageId") ?? "").trim();
      if (!/^\d{3,32}$/.test(pageId)) refuse("Choose a Page.");
      let name: string;
      try {
        name = await connectMetaPage({ tenantId, pageId });
      } catch (error) {
        return refuse(error instanceof Error ? error.message : "That Page could not be connected.");
      }
      await logAudit({ action: "integration.meta_connected", summary: `Connected the Facebook Page "${name}"`, user });
      revalidatePath("/settings/integrations");
      return { success: `Connected: ${name}` };
    }),
  );
}

/** Disconnect the workspace's Facebook Page: unsubscribed, forgotten, its messages no longer arrive here. */
export async function disconnectMeta() {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await getActiveTenantId();
      if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
      const name = await disconnectMetaPage(tenantId);
      if (!name) refuse("No Facebook Page is connected.");
      await logAudit({ action: "integration.meta_disconnected", summary: `Disconnected the Facebook Page "${name}"`, user });
      revalidatePath("/settings/integrations");
      return { success: "Disconnected. Messages from that Page no longer arrive here." };
    }),
  );
}
