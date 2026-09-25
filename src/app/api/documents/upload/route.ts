import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { logError } from "@/lib/errorLog";
import { photoBlobToken, photoUploadNeedsStaffSession } from "@/lib/photoBlob";
import { MAX_DOCUMENT_BYTES, documentUploadPrefix, parseDocumentTarget } from "@/lib/documentUpload";
import { authorizeDocumentTarget } from "@/lib/documentUploadAuth";
import { requirePermission } from "@/lib/permissions";

export const runtime = "nodejs";

/**
 * Signs a direct browser-to-storage upload for ONE document, for ONE target.
 *
 * Modelled on /api/photos/upload, which solved the same problem for photos:
 * a Server Action cannot take a request body over 4.5 MB on Vercel, so a large
 * file goes straight to Blob storage and is registered afterwards
 * (registerUploadedDocument). This route is the gate on the first half.
 *
 * It signs an upload only after checking the caller may file a document on the
 * claimed target in the active workspace, and only for a pathname under
 * `uploads/<tenant>/document/<target>/` — the prefix the register action will
 * insist on. The browser cannot widen either.
 *
 * Same session rule as the photo route: the token exchange runs inside
 * withActingStaffScope (a fresh request has no ambient workspace), and the
 * upload-completed callback from Vercel is NOT wrapped — it carries no staff
 * cookie, and its authority is Vercel's signature.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as HandleUploadBody;

  if (photoUploadNeedsStaffSession(body?.type)) {
    return withActingStaffScope(async () => {
      let tenantId: string;
      try {
        tenantId = await actingTenantId();
      } catch {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      return handleDocumentUpload(request, body, tenantId);
    });
  } else if (body?.type === "blob.upload-completed" && !request.headers.get("x-vercel-signature")) {
    // handleUpload refuses an unsigned callback anyway; refusing first keeps that
    // rejection out of the persistent System Log.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return handleDocumentUpload(request, body, null);
}

async function handleDocumentUpload(request: Request, body: HandleUploadBody, tenantId: string | null) {
  let failureContext = `event=${String(body?.type ?? "unknown")}`;
  const failureScope = body?.type === "blob.upload-completed" ? "document-upload-callback" : "document-upload-token";

  try {
    const response = await handleUpload({
      request,
      body,
      token: photoBlobToken(),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        if (!tenantId) throw new Error("No active workspace is available for this upload.");
        // Every document upload needs this permission, whatever it is filed on —
        // checked here first and explicitly, then narrowed to the record below.
        await requirePermission("documents.upload");
        const target = parseDocumentTarget(clientPayload);
        failureContext = `target=${JSON.stringify(target)}`;
        await authorizeDocumentTarget(target, tenantId);

        if (!pathname.startsWith(documentUploadPrefix(tenantId, target))) {
          throw new Error("The upload path does not belong to this record.");
        }
        return {
          // Any file type: company and customer paperwork is PDFs, Office files,
          // spreadsheets, images, archives. Safe to allow, because the CRM never
          // serves an upload inline unless it is an image or a PDF — everything
          // else downloads as an attachment with nosniff (see /api/files/[id]).
          maximumSizeInBytes: MAX_DOCUMENT_BYTES,
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ tenantId, target }),
        };
      },
      onUploadCompleted: async () => {
        // Nothing to do. The file is recorded by registerUploadedDocument, which
        // re-checks everything; an upload that is never registered is removed by
        // the orphan sweep after a day (lib/photoOrphanRules.ts).
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    // Only an IDENTIFIED caller may write a persistent row; an anonymous failure
    // (a forged callback) goes to the console, not the System Log, so this public
    // endpoint cannot be used to flood it.
    if (tenantId) {
      await logError(failureScope, error, failureContext, { tenantId, alert: false });
    } else {
      console.error(`[${failureScope}] ${failureContext}`, error);
    }
    return NextResponse.json(
      {
        error:
          body?.type === "blob.upload-completed"
            ? "The document upload completion callback failed."
            : "The upload could not be authorised. You may not have access to file documents here.",
      },
      { status: 400 },
    );
  }
}
