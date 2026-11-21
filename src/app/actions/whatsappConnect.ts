"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId, requireTenantOwner } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { disconnectWhatsApp } from "@/lib/whatsappConnect";

/** Disconnect a number connected through Connect WhatsApp: its messages stop arriving here; the number stays the business's. */
export async function disconnectWhatsAppNumber() {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      const user = await requireTenantOwner();
      const tenantId = await getActiveTenantId();
      if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
      const number = await disconnectWhatsApp(tenantId);
      if (!number) refuse("No WhatsApp number was connected with Connect WhatsApp.");
      await logAudit({ action: "integration.whatsapp_disconnected", summary: `Disconnected the WhatsApp number ${number}`, user });
      revalidatePath("/settings/integrations");
      return { success: "Disconnected. Messages to that number no longer arrive here." };
    }),
  );
}
