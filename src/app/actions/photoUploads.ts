"use server";

import { actingTenantId } from "@/lib/actingTenant";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { requireJobCardAccess, requireQuoteAccess } from "@/lib/permissions";

export type PhotoUploadTarget = {
  kind: "delivery" | "jobcard" | "jobcard-checkout" | "inspection";
  recordId: string;
  jobCardId?: string;
};

/**
 * Browser-to-blob transfer errors happen after token creation, outside the API
 * route. Record an intentionally sanitised event after re-authorising the target
 * so those failures are visible without accepting arbitrary client log entries.
 */
export async function reportPhotoUploadFailure(
  target: PhotoUploadTarget,
  detail: { stage: "prepare" | "transfer" | "finalize"; fileType?: string; fileSize?: number },
) {
  const tenantId = await actingTenantId();
  if (target.kind === "delivery") {
    await requireQuoteAccess(target.recordId, "deliveries.manage");
    const owned = await basePrisma.quote.findFirst({ where: { id: target.recordId, tenantId }, select: { id: true } });
    if (!owned) return;
  } else {
    const jobCardId = target.kind === "inspection" ? target.jobCardId : target.recordId;
    if (!jobCardId) return;
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    if (target.kind === "inspection") {
      const owned = await basePrisma.jobCardInspectionItem.findFirst({
        where: { id: target.recordId, jobCardId, tenantId },
        select: { id: true },
      });
      if (!owned) return;
    } else {
      const owned = await basePrisma.jobCard.findFirst({ where: { id: jobCardId, tenantId }, select: { id: true } });
      if (!owned) return;
    }
  }
  await logError(
    "photo-upload-client",
    new Error("A photo did not reach blob storage."),
    `kind=${target.kind} record=${target.recordId} stage=${detail.stage} type=${detail.fileType ?? "unknown"} bytes=${detail.fileSize ?? 0}`,
    { tenantId, alert: false },
  );
}
