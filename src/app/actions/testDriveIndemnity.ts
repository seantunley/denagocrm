"use server";

import { revalidatePath } from "next/cache";
import { asActionResult } from "@/lib/actionResult";
import { requireTestDriveManageAccess } from "@/lib/testDriveAccess";
import { prepareIndemnity } from "@/lib/testDriveIndemnity";

/**
 * "Sign indemnity on this device": make the booking's indemnity and open the
 * screen the driver signs on.
 *
 * Gated like every other change to the booking — whoever may manage this test
 * drive — and NOT on the Signatures permission: the salesperson handing over a
 * demo vehicle is the person who needs this, and they have no reason to hold
 * the keys to every contract in the workspace.
 */
export async function startTestDriveIndemnity(bookingId: string) {
  return asActionResult(async () => {
    const user = await requireTestDriveManageAccess(bookingId);
    await prepareIndemnity(bookingId, user);
    revalidatePath(`/test-drives/${bookingId}`);
    // Returned, not thrown: the button navigates only when the action says it worked.
    return { redirectTo: `/test-drives/${bookingId}/indemnity` };
  });
}
