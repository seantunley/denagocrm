"use server";

import { actingTenantId } from "@/lib/actingTenant";
import { requireUser } from "@/lib/auth";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { photoBlobAccess, photoBlobToken, type PhotoBlobAccess } from "@/lib/photoBlob";
import { requireJobCardAccess, requireQuoteAccess } from "@/lib/permissions";

export type PhotoUploadTarget = {
  kind: "delivery" | "jobcard" | "jobcard-checkout" | "inspection";
  recordId: string;
  jobCardId?: string;
};

/**
 * Return only the non-secret store access mode the browser must pass to
 * @vercel/blob/client. Resolving the token here is intentional: private mode
 * fails closed before the browser starts preparing a batch if its private store
 * token is missing.
 *
 * requireUser() is the guard, and actingTenantId() is NOT a substitute for it —
 * it resolves which workspace is acting, not whether the caller is anyone at
 * all. A Server Action is a POST endpoint reachable by anyone who can send the
 * request, so without this an anonymous caller learns the store's access mode
 * and, through the thrown token error, whether the private store is configured.
 * There is no record to authorize here: the per-record permission check belongs
 * to the token mint in /api/photos/upload, which is what actually grants write
 * access to a path.
 */
export async function getPhotoUploadAccess(): Promise<PhotoBlobAccess> {
  await requireUser();
  await actingTenantId();
  photoBlobToken();
  return photoBlobAccess();
}

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
