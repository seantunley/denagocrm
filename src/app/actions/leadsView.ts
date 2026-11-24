"use server";

import { redirect } from "next/navigation";
import { withActingStaffScope } from "@/lib/actingScope";
import { actingTenantId } from "@/lib/actingTenant";
import { leadsViewKey } from "@/lib/leadsViewPreference";
import { requireAnyPermission } from "@/lib/permissions";
import { putWorkspaceSetting } from "@/lib/settings";

/** Switch between the board and the list, and remember it for next time. */
export async function switchLeadsView(view: "board" | "list") {
  const target = view === "list" ? "list" : "board";
  await withActingStaffScope(async () => {
    const user = await requireAnyPermission("leads.view_all", "leads.view_owned");
    await putWorkspaceSetting(await actingTenantId(), leadsViewKey(user.id), target);
  });
  redirect(target === "list" ? "/leads/list" : "/leads");
}
