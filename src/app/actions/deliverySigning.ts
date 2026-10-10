"use server";

import { revalidatePath } from "next/cache";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { asActionResult, refuse, type ActionResult } from "@/lib/actionResult";
import { requireModuleEnabled } from "@/lib/modules/enabled";
import { requireQuoteAccess } from "@/lib/permissions";
import { prepareDeliveryNote, reviewedHandoverRuns } from "@/lib/deliveryNoteSigning";

/**
 * "Customer signs on this device": make the delivery note for this handover and
 * open the screen the customer signs on.
 *
 * Gated like every other step on the Deliveries board — whoever may manage this
 * delivery — and not on the Signatures permission: the driver handing over a
 * vehicle is the person who needs this.
 *
 * Everything the customer is about to sign for is settled HERE, before they are
 * handed the device: who is handing over, and — where a guided handover is set
 * up — that every checklist is complete and that the runs on the note are the
 * ones that were reviewed. All of it is then frozen into the note. Completing
 * the delivery afterwards reads it back from the signed note, never from a form.
 */
export async function startDeliveryNoteSigning(quoteId: string, formData: FormData): Promise<ActionResult> {
  return asActionResult(() => withActingStaffScope(async () => {
    await requireModuleEnabled("automotive");
    const user = await requireQuoteAccess(quoteId, "deliveries.manage");
    const tenantId = await actingTenantId();

    const claimedRunIds = String(formData.get("runIds") ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    const handover = await reviewedHandoverRuns(tenantId, quoteId, claimedRunIds);
    const deliveredByName = String(formData.get("deliveredByName") ?? "").trim();
    let checklist: Record<string, boolean> | null = null;
    if (handover.guided) {
      if (String(formData.get("deliveryNoteReviewed") ?? "") !== "yes") {
        refuse("Review the delivery note before asking the customer to sign.");
      }
      if (!deliveredByName) refuse("Enter who handed over the vehicle.");
    } else {
      // No guided handover: the built-in list, ticked on the delivery screen.
      try {
        const parsed: unknown = JSON.parse(String(formData.get("checklist") ?? ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          checklist = Object.fromEntries(Object.entries(parsed).map(([item, ticked]) => [item.slice(0, 200), ticked === true]));
        }
      } catch {}
    }

    await prepareDeliveryNote({ quoteId, tenantId, user, facts: { deliveredByName, runIds: handover.runIds, checklist } });
    revalidatePath("/deliveries");
    // Returned, not thrown: the button navigates only when the action says it worked.
    return { redirectTo: `/deliveries/${quoteId}/sign` };
  }));
}
