import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { actingTenantId } from "@/lib/actingTenant";
import { requireQuoteAccess } from "@/lib/permissions";
import { basePrisma } from "@/lib/db";
import { logError } from "@/lib/errorLog";

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

/**
 * Issues short-lived, quote-bound Blob tokens. Photo bytes go from the browser
 * to Blob one at a time, avoiding the hosting request-body limit entirely.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let tenantId: string | null = null;
  try {
    tenantId = await actingTenantId();
    const body = (await request.json()) as HandleUploadBody;
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = JSON.parse(clientPayload ?? "{}") as { quoteId?: string };
        const quoteId = String(payload.quoteId ?? "");
        if (!quoteId || !tenantId) throw new Error("The upload has no workspace or quote.");
        await requireQuoteAccess(quoteId, "deliveries.manage");
        const quote = await basePrisma.quote.findFirst({
          where: { id: quoteId, tenantId },
          select: { id: true, tenantId: true },
        });
        if (!quote?.tenantId) throw new Error("This quote is not available in the active workspace.");
        const prefix = `uploads/${quote.tenantId}/delivery/${quote.id}/`;
        if (!pathname.startsWith(prefix)) throw new Error("The upload path does not belong to this quote.");
        return {
          allowedContentTypes: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
          maximumSizeInBytes: MAX_PHOTO_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ tenantId: quote.tenantId, quoteId: quote.id }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = JSON.parse(tokenPayload ?? "{}") as { tenantId?: string; quoteId?: string };
        if (!payload.tenantId || !payload.quoteId) {
          await logError("delivery-photo-upload-completed", new Error("Missing token ownership"), blob.pathname, {
            tenantId: payload.tenantId ?? null,
            alert: false,
          });
        }
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    await logError("delivery-photo-token", error, "direct upload token request", {
      tenantId,
      alert: false,
    });
    return NextResponse.json({ error: "The photo upload could not be authorised." }, { status: 400 });
  }
}
