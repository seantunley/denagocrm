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

  try {
    // The browser token exchange has the signed-in staff session. Vercel's
    // upload-completed callback is server-to-server and intentionally does not.
    if (photoUploadNeedsStaffSession(body?.type)) {
      tenantId = await actingTenantId();
    }

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
    await logError(
      failureScope,
      error,
      failureContext,
      { tenantId, alert: false },
    );
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
