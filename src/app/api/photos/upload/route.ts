import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { actingTenantId } from "@/lib/actingTenant";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
import { photoBlobToken, photoUploadNeedsStaffSession } from "@/lib/photoBlob";
import { MAX_PHOTO_BYTES } from "@/lib/photoBudget";
import { requireJobCardAccess, requireQuoteAccess } from "@/lib/permissions";

export const runtime = "nodejs";

type PhotoTarget = {
  kind: "delivery" | "jobcard" | "jobcard-checkout" | "inspection";
  recordId: string;
  jobCardId?: string;
};

function parseTarget(raw: string | null | undefined): PhotoTarget {
  const value = JSON.parse(raw ?? "{}") as Partial<PhotoTarget>;
  if (!["delivery", "jobcard", "jobcard-checkout", "inspection"].includes(String(value.kind)) || !value.recordId) {
    throw new Error("Invalid photo upload target.");
  }
  return { kind: value.kind as PhotoTarget["kind"], recordId: String(value.recordId), jobCardId: value.jobCardId ? String(value.jobCardId) : undefined };
}

function parseCompletionOwnership(raw: string | null | undefined): Partial<PhotoTarget> & { tenantId?: string } {
  try {
    return JSON.parse(raw ?? "{}") as Partial<PhotoTarget> & { tenantId?: string };
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;
  let tenantId: string | null = null;
  let failureContext = `event=${String(body?.type ?? "unknown")}`;
  const failureScope = body?.type === "blob.upload-completed"
    ? "photo-upload-callback"
    : "photo-upload-token";

  /*
   * REFUSE UNIDENTIFIED CALLERS HERE, BEFORE ANYTHING IS RECORDED.
   *
   * This route is in PUBLIC_PATHS so Vercel's signed callback can reach it — a
   * server-to-server request with no session cookie. That necessarily means an
   * anonymous caller can reach it too, and every failure below writes a
   * persistent ErrorLog row. Left inside the try, the endpoint was a way for
   * anyone on the internet to fill a tenant's System Log with unbounded rows by
   * POSTing nonsense in a loop.
   *
   * The browser token exchange carries the staff session; the callback carries a
   * signature instead. Neither present means there is nobody to attribute the
   * failure to, so it is refused without a trace rather than logged.
   */
  if (photoUploadNeedsStaffSession(body?.type)) {
    try {
      tenantId = await actingTenantId();
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (body?.type === "blob.upload-completed" && !request.headers.get("x-vercel-signature")) {
    // handleUpload refuses an unsigned callback anyway; refusing first is what
    // keeps that refusal out of the database.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {

    const response = await handleUpload({
      request,
      body,
      token: photoBlobToken(),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!tenantId) throw new Error("No active workspace is available for this photo upload.");
        const target = parseTarget(clientPayload);
        failureContext = `kind=${target.kind} record=${target.recordId}`;
        if (target.kind === "delivery") {
          await requireQuoteAccess(target.recordId, "deliveries.manage");
          const quote = await basePrisma.quote.findFirst({
            where: { id: target.recordId, tenantId },
            select: { id: true, tenantId: true },
          });
          if (!quote?.tenantId) throw new Error("This quote is not available in the active workspace.");
        } else if (target.kind === "inspection") {
          if (!target.jobCardId) throw new Error("Missing inspection job card.");
          await requireJobCardAccess(target.jobCardId, "jobcards.manage");
          const item = await basePrisma.jobCardInspectionItem.findFirst({
            where: { id: target.recordId, jobCardId: target.jobCardId, tenantId },
            select: { id: true },
          });
          if (!item) throw new Error("This inspection item is not available in the active workspace.");
        } else {
          await requireJobCardAccess(target.recordId, "jobcards.manage");
          const jobCard = await basePrisma.jobCard.findFirst({
            where: { id: target.recordId, tenantId },
            select: { id: true, tenantId: true },
          });
          if (!jobCard?.tenantId) throw new Error("This job card is not available in the active workspace.");
        }

        const prefix = `uploads/${tenantId}/${target.kind}/${target.recordId}/`;
        if (!pathname.startsWith(prefix)) {
          throw new Error("The upload path does not belong to this record.");
        }
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
          maximumSizeInBytes: MAX_PHOTO_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ tenantId, ...target }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // handleUpload verifies Vercel's callback signature before this runs.
        // Ownership therefore comes from the signed token payload, not a staff
        // session/cookie that does not exist on the callback request.
        const ownership = parseCompletionOwnership(tokenPayload);
        if (!ownership.tenantId || !ownership.recordId || !ownership.kind) {
          await logError("photo-upload-completed", new Error("Missing upload ownership"), blob.pathname, {
            tenantId: ownership.tenantId ?? null,
            alert: false,
          });
        }
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    // Only an IDENTIFIED caller may write a persistent row. A caller that got
    // past the gate above but failed here — a forged signature, a malformed
    // callback — still has no tenant to attribute anything to, and a public
    // endpoint that writes to the database on every failure is a log-flooding
    // primitive. Those go to the console, which rotates, not the System Log,
    // which does not.
    if (tenantId) {
      await logError(
        failureScope,
        error,
        failureContext,
        { tenantId, alert: false },
      );
    } else {
      console.error(`[${failureScope}] ${failureContext}`, error);
    }
    return NextResponse.json(
      {
        error: body?.type === "blob.upload-completed"
          ? "The photo upload completion callback failed."
          : "The photo upload could not be authorised. See Settings → System Log.",
      },
      { status: 400 },
    );
  }
}
