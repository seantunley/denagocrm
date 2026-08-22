import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
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

  /*
   * THE TOKEN EXCHANGE NEEDS AN ENCLOSING STAFF SCOPE.
   *
   * This route is a fresh request, not a descendant of the page that rendered the
   * camera. Calling actingTenantId() directly therefore repeats the production
   * failure that blocked getPhotoUploadPlan: under enforcement there is no ambient
   * scope in this frame, so writeTenantId() refuses before the session rung can be
   * consulted.
   *
   * withActingStaffScope is the existing Server-Action/API recovery boundary. It
   * fully revalidates the signed staff session, never replaces an existing scope,
   * and binds the recovered tenant AROUND everything below it so record guards and
   * guarded Prisma reads inherit the same workspace. If recovery cannot establish
   * one, actingTenantId still refuses and this remains a 401 — no fallback tenant,
   * no widened access.
   *
   * The Vercel upload-completed callback is intentionally NOT wrapped: it has no
   * staff cookie. Its authority is the Vercel signature plus the signed token
   * payload minted below.
   */
  if (photoUploadNeedsStaffSession(body?.type)) {
    return withActingStaffScope(async () => {
      let tenantId: string;
      try {
        tenantId = await actingTenantId();
      } catch {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handlePhotoUpload(request, body, tenantId);
    });
  } else if (body?.type === "blob.upload-completed" && !request.headers.get("x-vercel-signature")) {
    // handleUpload refuses an unsigned callback anyway; refusing first is what
    // keeps that rejection out of the persistent System Log.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handlePhotoUpload(request, body, null);
}

async function handlePhotoUpload(
  request: Request,
  body: HandleUploadBody,
  tenantId: string | null,
) {
  let failureContext = `event=${String(body?.type ?? "unknown")}`;
  const failureScope = body?.type === "blob.upload-completed"
    ? "photo-upload-callback"
    : "photo-upload-token";

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
