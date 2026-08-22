"use server";

import { asActionResult } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
import { withPhotoActionScope as withActingStaffScope } from "./photoActionScope";
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

/**
 * How this deployment can accept photos.
 *
 * NOT EVERY DEPLOYMENT HAS A BLOB STORE. storage.ts supports two modes by
 * design: Vercel Blob when a token is set, and files on disk under
 * storage/uploads when self-hosted. Browser-to-Blob uploads only exist in the
 * first, so making the camera unconditionally use @vercel/blob/client took photo
 * capture away from the second entirely — the upload call fails before the
 * server is reached, and the "one file per request" benefit is irrelevant there
 * anyway because there is no Server Action body to get around.
 *
 * `form` means: post the files to the original upload action, which writes
 * through saveFile() and therefore works in both modes. That path still exists
 * and is still tested; this just decides which one the camera uses.
 *
 * Private mode with no private token still THROWS rather than reporting `form`.
 * A missing private token is a misconfiguration to fix, and quietly routing
 * sensitive photos down a different path would hide it.
 */
export type PhotoUploadPlan =
  | { transport: "direct"; access: PhotoBlobAccess }
  | { transport: "form" };

export async function getPhotoUploadPlan(): Promise<PhotoUploadPlan | { error: string }> {
  /*
   * THE REAL ERROR MUST BE LOGGED HERE, ON THE SERVER.
   *
   * This threw raw. A Server Action that throws is redacted by Next before the
   * browser sees it — "An error occurred in the Server Components render. The
   * specific message is omitted in production builds" — so the one place the
   * cause existed was the one place nothing recorded it, and the client could
   * not report what it had never been told. That is why the System Log stayed
   * empty however much the browser-side reporting was improved.
   *
   * asActionResult is the established answer: it logs the REAL error with a
   * reference and hands back a message safe to show, carrying that same
   * reference so the row can be found from the screen that mentioned it. Every
   * other action in this codebase already goes through it; this one did not.
   */
  /*
   * IT DOES NOT RESOLVE A WORKSPACE, AND MUST NOT.
   *
   * This used to `await actingTenantId()` and THROW THE RESULT AWAY. Nothing here
   * needs a workspace: the only thing this action reveals is which Blob store
   * mode the deployment uses, which is a property of the deployment and not of
   * any tenant. The call was a gate that gated nothing.
   *
   * It was also the first server call the camera makes, and actingTenantId throws
   * when a sign-in resolves no workspace. So a session with no `tid` claim could
   * not take a photo — stopped by a line whose value was discarded — and because
   * the same missing claim also blanks the System Log, the failure was invisible.
   *
   * requireUser() is the gate that belongs here, and it stays: this is
   * staff-only. The real per-record authorisation happens where a decision is
   * actually made — /api/photos/upload mints the token and checks access to that
   * specific record, and the scoped finalizers re-check before filing anything.
   */
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

/**
 * Browser-to-blob transfer errors happen after token creation, outside the API
 * route — so the browser is the only witness. Record a sanitised event, without
 * accepting arbitrary client log entries.
 *
 * The whole reporter runs inside the recovered staff scope when one exists. A
 * Server Action cannot inherit the page's ALS frame, and entering a scope inside
 * a nested guard does not flow back UP into this action. Binding an enclosing
 * frame here is what makes the tenant available to every call below. If recovery
 * cannot establish a valid staff workspace, withActingStaffScope deliberately
 * runs the body bare and the existing fail-closed/unknown logic still applies.
 */
export async function reportPhotoUploadFailure(
  target: PhotoUploadTarget,
  detail: PhotoFailureDetail,
) {
  return withActingStaffScope(async () => {
    await recordPhotoUploadFailure(
      {
        // Identity WITHOUT demanding a workspace. getCurrentUser resolves the
        // person and enters their scope if one exists, but the reporter still has
        // to handle the legitimate "workspace unresolved" diagnostic path.
        identify: () => getCurrentUser(),
        resolveTenant: actingTenantId,
        authorise: async (t, tenantId) => {
          // Permission first, and never conditional: this is what stops the action
          // being a way to write arbitrary rows. The tenant-ownership re-check on
          // top of it needs a tenant, so it is skipped when there is not one —
          // recorded as "unknown" rather than silently treated as a pass.
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
        // Only a TenantScopeError means "could not establish the workspace".
        // requireQuoteAccess denies by calling redirect(), which throws, so any
        // other throw here is a refusal and must suppress the row.
        isWorkspaceFailure: (error) => error instanceof TenantScopeError,
        log: ({ message, context, tenantId }) =>
          logError("photo-upload-client", new Error(message), context, { tenantId, alert: false }),
      },
      target,
      detail,
    );
  });
}

/*
 * PHOTO SERVER ACTIONS NEED AN ENCLOSING STAFF SCOPE.
 *
 * The browser-to-Blob flow crosses request boundaries three times: plan, token,
 * then finalizer. The form fallback is a Server Action too. The underlying
 * fulfilment/job-card actions correctly authorise their records, but several of
 * them call actingTenantId() or guarded Prisma after the action has already lost
 * the page's AsyncLocalStorage frame. A guard that recovers a scope inside its own
 * callee cannot make that scope flow back up into the action frame.
 *
 * These thin entrypoints bind the recovered staff scope AROUND the whole existing
 * action. They add no authority: recoverStaffScopeFromSession fully revalidates
 * the session, an existing narrower/system scope is never replaced, and if no
 * valid scope can be recovered the underlying action runs bare and fails closed
 * exactly as before. All record permissions and Blob ownership checks remain in
 * the underlying actions; this only supplies the execution context they require.
 *
 * The outer asActionResult is deliberate even though the delegated action also
 * uses it: dynamic import / facade failures happen BEFORE the delegate can log
 * anything. The outer layer gives those failures a durable reference too, while
 * a normal delegated {success}/{error} result passes through unchanged.
 */
export async function registerDeliveryPhotos(recordId: string, staged: StagedPhoto[]) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./fulfilment");
    return actions.registerDeliveryPhotos(recordId, staged);
  }, { scope: "delivery-photo-entry" }));
}

export async function uploadDeliveryPhotos(recordId: string, formData: FormData) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./fulfilment");
    return actions.uploadDeliveryPhotos(recordId, formData);
  }, { scope: "delivery-photo-form-entry" }));
}

export async function registerJobCardPhotos(
  recordId: string,
  staged: StagedPhoto[],
  category: "checkin" | "checkout" = "checkin",
) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.registerJobCardPhotos(recordId, staged, category);
  }, { scope: "jobcard-photo-entry" }));
}

export async function uploadJobCardPhotos(recordId: string, formData: FormData) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadJobCardPhotos(recordId, formData);
  }, { scope: "jobcard-photo-form-entry" }));
}

export async function uploadCheckoutPhotos(recordId: string, formData: FormData) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadCheckoutPhotos(recordId, formData);
  }, { scope: "jobcard-checkout-photo-form-entry" }));
}

export async function registerInspectionPhoto(
  recordId: string,
  jobCardId: string,
  staged: StagedPhoto[],
) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.registerInspectionPhoto(recordId, jobCardId, staged);
  }, { scope: "inspection-photo-entry" }));
}

export async function uploadInspectionPhoto(
  recordId: string,
  jobCardId: string,
  formData: FormData,
) {
  return withActingStaffScope(() => asActionResult(async () => {
    const actions = await import("./jobcards");
    return actions.uploadInspectionPhoto(recordId, jobCardId, formData);
  }, { scope: "inspection-photo-form-entry" }));
}
