import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { actingTenantId } from "@/lib/actingTenant";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";
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

export async function POST(request: Request) {
  let tenantId: string | null = null;
  let target: PhotoTarget | null = null;
  try {
    tenantId = await actingTenantId();
    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        target = parseTarget(clientPayload);
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
        const ownership = JSON.parse(tokenPayload ?? "{}") as Partial<PhotoTarget> & { tenantId?: string };
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
      "photo-upload-token",
      error,
      `kind=${target?.kind ?? "unknown"} record=${target?.recordId ?? "unknown"}`,
      { tenantId, alert: false },
    );
    return NextResponse.json(
      { error: "The photo upload could not be authorised. See Settings → System Log." },
      { status: 400 },
    );
  }
}
