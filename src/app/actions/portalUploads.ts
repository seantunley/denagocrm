"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { logAudit } from "@/lib/audit";
import { requireContactAccess, requirePermission } from "@/lib/permissions";
import { asActionResult, refuse } from "@/lib/actionResult";

/**
 * Staff have looked at a file the customer uploaded through the portal (gap audit
 * #30). Uploads not attached to a case had no staff screen at all; they are now
 * listed on the customer's Documents tab and in the Documents queue until this
 * marks them reviewed.
 */
export async function markPortalUploadReviewed(id: string) {
  return asActionResult(async () => {
    await requirePermission("documents.manage");
    // The guarded client: another workspace's upload id matches nothing.
    const upload = await prisma.portalUpload.findUnique({
      where: { id },
      select: { id: true, contactId: true, fileName: true, status: true },
    });
    if (!upload) refuse("That upload is no longer there — refresh the page.");
    const user = await requireContactAccess(upload.contactId, "documents.manage");
    if (upload.status === "reviewed") return { success: "Already reviewed" };
    await prisma.portalUpload.update({ where: { id }, data: { status: "reviewed" } });
    await logAudit({
      action: "portal.file_reviewed",
      summary: `Reviewed “${upload.fileName}” uploaded through the customer portal`,
      contactId: upload.contactId,
      user,
    });
    revalidatePath(`/contacts/${upload.contactId}`);
    revalidatePath("/documents");
    return { success: "Marked reviewed" };
  });
}
