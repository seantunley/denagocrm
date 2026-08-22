"use server";

import { asActionResult } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { withPhotoActionScope } from "./photoActionScope";
import { TenantScopeError } from "@/lib/tenantGuard";
import { getCurrentUser, requireUser } from "@/lib/auth";
import { recordPhotoUploadFailure, type PhotoFailureDetail } from "@/lib/photoFailureReport";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { photoBlobAccess, photoBlobToken, type PhotoBlobAccess } from "@/lib/photoBlob";
import { requireJobCardAccess, requireQuoteAccess } from "@/lib/permissions";

export type PhotoUploadTarget = {
  kind: "delivery" | "jobcard" | "jobcard-checkout" | "inspection";
  recordId: string;
  jobCardId?: string;
};

type StagedPhoto = { url: string };

export type PhotoUploadPlan =
  | { transport: "direct"; access: PhotoBlobAccess }
  | { transport: "form" };

export async function getPhotoUploadPlan(): Promise<PhotoUploadPlan | { error: string }> {
  let plan: PhotoUploadPlan | null = null;
  const outcome = await asActionResult(async () => {
    await requireUser();
    const token = photoBlobToken();
    plan = token ? { transport: "direct", access: photoBlobAccess() } : { transport: "form" };
  }, { scope: "photo-upload-plan" });

  if (outcome.error || !plan) {
    return { error: outcome.error ?? "The upload could not be prepared." };
  }
  return plan;
}

export async function reportPhotoUploadFailure(
  target: PhotoUploadTarget,
  detail: PhotoFailureDetail,
) {
  return withPhotoActionScope(async () => {
    await recordPhotoUploadFailure(
      {
        identify: () => getCurrentUser(),
        resolveTenant: actingTenantId,
        authorise: async (t, tenantId) => {
          if (t.kind === "delivery") {
            await requireQuoteAccess(t.recordId, "deliveries.manage");
            if (!tenantId) return true;
            const owned = await basePrisma.quote.findFirst({ where: { id: t.recordId, tenantId }, select: { id: true } });
            return Boolean(owned);
          }
          const jobCardId = t.kind === "inspection" ? t.jobCardId : t.recordId;
          if (!jobCardId) return false;
          await requireJobCardAccess(jobCardId, "jobcards.manage");
          if (!tenantId) return true;
          if (t.kind === "inspection") {
            const owned = await basePrisma.jobCardInspectionItem.findFirst({
              where: { id: t.recordId, jobCardId, tenantId },
              select: { id: true },
            });
            return Boolean(owned);
          }
          const owned = await basePrisma.jobCard.findFirst({ where: { id: jobCardId, tenantId }, select: { id: true } });
          return Boolean(owned);
        },
        isWorkspaceFailure: (error) => error instanceof TenantScopeError,
        log: ({ message, context, tenantId }) =>
          logError("photo-upload-client", new Error(message), context, { tenantId, alert: false }),
      },
      target,
      detail,
    );
  });
}

export async function registerDeliveryPhotos(recordId: string, staged: StagedPhoto[]) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./fulfilment");
    return actions.registerDeliveryPhotos(recordId, staged);
  }, { scope: "delivery-photo-entry" }));
}

export async function uploadDeliveryPhotos(recordId: string, formData: FormData) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./fulfilment");
    return actions.uploadDeliveryPhotos(recordId, formData);
  }, { scope: "delivery-photo-form-entry" }));
}

export async function registerJobCardPhotos(
  recordId: string,
  staged: StagedPhoto[],
  category: "checkin" | "checkout" = "checkin",
) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.registerJobCardPhotos(recordId, staged, category);
  }, { scope: "jobcard-photo-entry" }));
}

export async function uploadJobCardPhotos(recordId: string, formData: FormData) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadJobCardPhotos(recordId, formData);
  }, { scope: "jobcard-photo-form-entry" }));
}

export async function uploadCheckoutPhotos(recordId: string, formData: FormData) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadCheckoutPhotos(recordId, formData);
  }, { scope: "jobcard-checkout-photo-form-entry" }));
}

export async function registerInspectionPhoto(
  recordId: string,
  jobCardId: string,
  staged: StagedPhoto[],
) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.registerInspectionPhoto(recordId, jobCardId, staged);
  }, { scope: "inspection-photo-entry" }));
}

export async function uploadInspectionPhoto(
  recordId: string,
  jobCardId: string,
  formData: FormData,
) {
  return withPhotoActionScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadInspectionPhoto(recordId, jobCardId, formData);
  }, { scope: "inspection-photo-form-entry" }));
}
