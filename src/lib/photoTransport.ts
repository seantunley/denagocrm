/**
 * How a photo gets from a camera to blob storage. ONE implementation.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────────
 *
 * Both halves of this file used to live inside DirectPhotoUploader.tsx, which
 * was fine while that component was the only thing sending a photo. It is not
 * any more: the guided checklist runner sends photos too, from a queue, minutes
 * or hours after the camera fired.
 *
 * Copying the twelve lines would have put the BLOB PATH in two places, and the
 * blob path is not decoration — `/api/photos/upload` refuses any pathname that
 * does not begin with `uploads/<tenant>/<kind>/<record>/`, and that refusal is
 * the whole of the tenant isolation on direct-to-blob uploads. Two copies of a
 * prefix that must match a server check exactly is the drift that ends with one
 * caller silently unable to upload anything, and nobody able to say why.
 *
 * So: the prefix is built here, once, by the same arithmetic the route checks.
 *
 * ── NOT `photoBudget.ts` ────────────────────────────────────────────────────
 *
 * That module is deliberately pure and DOM-free so the size arithmetic can be
 * tested without a browser. This one needs `createImageBitmap`, a canvas and
 * `fetch`, so it stays separate rather than dragging the DOM into a module whose
 * tests depend on not having it.
 */
import { upload } from "@vercel/blob/client";
import {
  MAX_PHOTO_BYTES,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  fitWithinMaxEdge,
} from "@/lib/photoBudget";

/**
 * What a photo can be attached to.
 *
 * `src/app/api/photos/upload/route.ts` is the authority — it parses this off the
 * client payload and refuses anything not in its own list. Restated here because
 * that route imports Prisma and `server-only` and therefore cannot be imported
 * by a client component. A kind added there and forgotten here is a compile
 * error at the call site rather than a runtime refusal, which is the direction
 * that costs least.
 */
export type PhotoKind = "delivery" | "jobcard" | "jobcard-checkout" | "inspection" | "checklist";

export type PhotoTarget = {
  kind: PhotoKind;
  /** The record the photo hangs off — for `checklist` this is the ENTRY id. */
  recordId: string;
  /** Required by the `inspection` kind, which authorises against its job card. */
  jobCardId?: string;
};

/**
 * Shrink a photo before it is sent anywhere.
 *
 * A modern phone produces a 4000px original that costs roughly six times the
 * bytes of the 1600px version, and a job-card condition photo is evidence of a
 * scratch rather than a print. The failure this prevents is not aesthetic: on a
 * one-bar connection in a driveway, the difference between 400 KB and 4 MB is
 * the difference between an upload that finishes and one that times out and is
 * retried until the retries run out.
 *
 * Every failure path returns the ORIGINAL file rather than throwing. A format
 * `createImageBitmap` cannot decode (HEIC on some browsers), a canvas the
 * browser refuses to give a 2D context for, a re-encode that came out larger
 * than it started — in all of those the original is still a photo somebody took,
 * and refusing it to protect a size optimisation would lose evidence to save
 * bandwidth.
 */
export async function preparePhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const { width, height } = fitWithinMaxEdge(bitmap.width, bitmap.height, PHOTO_MAX_EDGE);
  if (width === bitmap.width && height === bitmap.height) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    return file;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", PHOTO_JPEG_QUALITY),
  );
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}

/**
 * Why this file cannot be sent, or null when it can.
 *
 * Answered BEFORE the request goes out. The upload route enforces the same two
 * bounds and would reject the file itself, but it does so by refusing to mint a
 * token, which reaches the browser as a generic authorisation failure — the
 * person is told the upload was not authorised when the truth is that their
 * phone produced a 12 MB HEIC the browser could not shrink. A reason stated here
 * is a reason they can act on.
 */
export function unsendablePhoto(file: File): string | null {
  if (!file.type.startsWith("image/")) return "That file is not a photo.";
  if (file.size <= 0) return "That photo is empty.";
  if (file.size > MAX_PHOTO_BYTES) {
    return "That photo is still too large after resizing. Try a lower camera resolution.";
  }
  return null;
}

/**
 * Send one prepared photo straight to blob storage and hand back its URL.
 *
 * ── THE PATH IS THE PERMISSION ──────────────────────────────────────────────
 *
 * `/api/photos/upload` resolves the tenant from the SESSION, checks the caller
 * may touch this record, and then refuses to sign any pathname that does not
 * start with `uploads/<that tenant>/<kind>/<record>/`. So the prefix below is
 * not a naming convention — it is the claim the server checks, and a caller that
 * builds it differently gets nothing signed. Built here so there is one copy of
 * it on the client.
 *
 * `key` names the blob. The checklist runner passes the photo's own client id so
 * a blob found in storage can be traced back to the row that describes it; the
 * default is a fresh UUID, which is all the other callers need. The route also
 * sets `addRandomSuffix`, so the STORED path is not exactly this one — which is
 * why the returned URL is what callers must record, never the string built here.
 */
/**
 * WHICH BLOB STORE this deployment files photos in, asked once per page.
 *
 * `getPhotoUploadPlan()` is a Server Action, and the checklist runner drains its
 * queue one photo at a time — asking per photo would be a round trip per file
 * for an answer that cannot change while the page is open. Memoised on the
 * promise so concurrent drains share the one call.
 *
 * A deployment with NO blob store reports `transport: "form"`, and there is no
 * browser-to-blob path at all there. The senders that use this module have no
 * form fallback, so that is surfaced as a stated reason rather than left to fail
 * as an opaque upload error.
 */
let accessPromise: Promise<"public" | "private"> | null = null;

export function forgetPhotoUploadAccess() {
  accessPromise = null;
}

export function photoUploadAccess(): Promise<"public" | "private"> {
  accessPromise ??= (async () => {
    const { getPhotoUploadPlan } = await import("@/app/actions/photoUploads");
    const plan = await getPhotoUploadPlan();
    // The plan is also how a misconfiguration reports itself — asActionResult
    // turns a thrown one into `{ error }` rather than letting it escape — so the
    // stated reason is passed on instead of being flattened into "no storage".
    if ("error" in plan) throw new Error(plan.error);
    if (plan.transport !== "direct") {
      throw new Error(
        "This deployment has no photo storage configured, so photos cannot be uploaded from this screen.",
      );
    }
    return plan.access;
  })().catch((error) => {
    // Do not memoise a failure: a transient one would poison every later photo
    // for the life of the page.
    accessPromise = null;
    throw error;
  });
  return accessPromise;
}

export async function uploadPhoto(
  target: PhotoTarget & { tenantId: string; key?: string; access: "public" | "private" },
  file: File,
): Promise<string> {
  const key = target.key ?? crypto.randomUUID();
  const blob = await upload(
    `uploads/${target.tenantId}/${target.kind}/${target.recordId}/${key}-${file.name}`,
    file,
    {
      /*
       * WHICH STORE, decided by the server and passed in.
       *
       * `getPhotoUploadPlan()` reports whether this deployment files photos in
       * the public or the private Blob store; the token that proves it never
       * leaves the server. Hardcoding "public" here would file every photo in
       * the wrong store the moment a deployment set BLOB_PRIVATE, silently and
       * with no error to notice.
       */
      access: target.access,
      handleUploadUrl: "/api/photos/upload",
      clientPayload: JSON.stringify({
        kind: target.kind,
        recordId: target.recordId,
        jobCardId: target.jobCardId,
      }),
    },
  );
  return blob.url;
}
