"use server";

import { revalidatePath } from "next/cache";
import { asActionResult, refuse } from "@/lib/actionResult";
import { withActingStaffScope } from "@/lib/actingScope";
import { getActiveTenantId } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { requirePermission, requireVehicleAccess } from "@/lib/permissions";

/**
 * Mark a vehicle's document as one that passes to the vehicle's next owner (warranty-transfer-brief.md, PR 2): the
 * service book, the warranty certificate. Off, a new owner never sees a document added before they took over.
 */
export async function setDocumentStaysWithVehicle(documentId: string, revalidate: string, formData: FormData) {
  return withActingStaffScope(() =>
    asActionResult(async () => {
      await requirePermission("vehicles.manage");
      const tenantId = await getActiveTenantId();
      if (!tenantId) return refuse("No workspace attached to this sign-in — sign out and back in.");
      const doc = await prisma.document.findFirst({ where: { id: documentId, tenantId, deletedAt: null }, select: { id: true, fileName: true, vehicleId: true } });
      if (!doc?.vehicleId) return refuse("That document isn't on a vehicle any more. Refresh the page.");
      const user = await requireVehicleAccess(doc.vehicleId, "vehicles.manage");
      const on = formData.get("on") === "on";
      const changed = await prisma.document.updateMany({ where: { id: doc.id, tenantId, deletedAt: null }, data: { staysWithVehicle: on } });
      if (changed.count !== 1) refuse("That document changed just now. Refresh the page.");
      await logAudit({
        action: "document.stays_with_vehicle",
        summary: `${on ? "Marked" : "Unmarked"} “${doc.fileName}” as staying with the vehicle for its next owner`,
        entityType: "Document",
        entityId: doc.id,
        user,
      });
      if (revalidate.startsWith("/")) revalidatePath(revalidate);
      return { success: on ? "Stays with the vehicle" : "Stays with the owner of the time" };
    }),
  );
}
