"use server";

import { asActionResult } from "@/lib/actionResult";
import { actingTenantId } from "@/lib/actingTenant";
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
  let plan: PhotoUploadPlan | null = null;
  const outcome = await asActionResult(async () => {
    await requireUser();
    await actingTenantId();
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
 * The decision logic lives in lib/photoFailureReport.ts with its effects
 * injected, because the interesting behaviour here is what happens when those
 * effects THROW, and that cannot be established by reading this file top to
 * bottom. See its comment for why the order changed.
 */
export async function reportPhotoUploadFailure(
  target: PhotoUploadTarget,
  detail: PhotoFailureDetail,
) {
  await recordPhotoUploadFailure(
    {
      // Identity WITHOUT a workspace. getCurrentUser resolves the person and
      // enters their scope if one exists, but does not demand that one does —
      // which is what lets this run in the case worth reporting.
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
}
