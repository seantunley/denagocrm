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

export async function getPhotoUploadPlan(): Promise<PhotoUploadPlan> {
  await requireUser();
  await actingTenantId();
  const token = photoBlobToken();
  if (!token) return { transport: "form" };
  return { transport: "direct", access: photoBlobAccess() };
}

/**
 * Browser-to-blob transfer errors happen after token creation, outside the API
 * route. Record an intentionally sanitised event after re-authorising the target
 * so those failures are visible without accepting arbitrary client log entries.
 */
export async function reportPhotoUploadFailure(
  target: PhotoUploadTarget,
  detail: {
    stage: "prepare" | "transfer" | "finalize";
    fileType?: string;
    fileSize?: number;
    /**
     * What the browser actually caught.
     *
     * The one fact worth having, and it used not to be sent at all: the client
     * caught the error, discarded it, and logged "A photo did not reach blob
     * storage" — a sentence that describes the symptom already on screen and
     * names no cause. Truncated because it is client-supplied text going into a
     * log row, and logged as CONTEXT rather than as the error, so it can never
     * be mistaken for something the server observed.
     */
    reason?: string;
  },
) {
  /*
   * THIS MUST SURVIVE THE FAILURE IT IS REPORTING, and it did not.
   *
   * It opened with a bare `await actingTenantId()`, which THROWS when the
   * sign-in resolves no workspace. That is one of the failures an upload hits —
   * a Server Action does not inherit the page's tenant scope — so in exactly the
   * case worth recording, the recorder threw first, the client's `.catch(() => {})`
   * swallowed it, and the System Log stayed empty while the message on screen
   * insisted the reason was in it.
   *
   * The tenant is now best-effort. It is still the attribution for the row when
   * it resolves; when it does not, the row is written unattributed rather than
   * not at all.
   */
  let tenantId: string | null = null;
  try {
    tenantId = await actingTenantId();
  } catch {
    tenantId = null;
  }

  /*
   * The permission check is NOT best-effort and never becomes optional — it is
   * what stops this being an endpoint for writing arbitrary log rows. The
   * tenant-ownership re-check below is defence in depth on top of it, and is the
   * only part skipped when there is no tenant to check against.
   */
  if (target.kind === "delivery") {
    await requireQuoteAccess(target.recordId, "deliveries.manage");
    if (tenantId) {
      const owned = await basePrisma.quote.findFirst({ where: { id: target.recordId, tenantId }, select: { id: true } });
      if (!owned) return;
    }
  } else {
    const jobCardId = target.kind === "inspection" ? target.jobCardId : target.recordId;
    if (!jobCardId) return;
    await requireJobCardAccess(jobCardId, "jobcards.manage");
    if (tenantId && target.kind === "inspection") {
      const owned = await basePrisma.jobCardInspectionItem.findFirst({
        where: { id: target.recordId, jobCardId, tenantId },
        select: { id: true },
      });
      if (!owned) return;
    } else if (tenantId) {
      const owned = await basePrisma.jobCard.findFirst({ where: { id: jobCardId, tenantId }, select: { id: true } });
      if (!owned) return;
    }
  }
  // The REASON leads. "A photo did not reach blob storage" restates the symptom
  // the person already saw and names no cause, which is what made this log row
  // worthless to read. Sanitised: one line, length-capped, and marked as coming
  // from the browser so nobody reads it as a server observation.
  const reason = (detail.reason ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  await logError(
    "photo-upload-client",
    new Error(reason ? `A photo did not reach blob storage: ${reason}` : "A photo did not reach blob storage (the browser reported no reason)."),
    `kind=${target.kind} record=${target.recordId} stage=${detail.stage} type=${detail.fileType ?? "unknown"} bytes=${detail.fileSize ?? 0} source=browser`,
    { tenantId, alert: false },
  );
}
