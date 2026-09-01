import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

/** Issues short-lived tokens so the browser can upload library files straight to Blob storage. */
export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Uploading to the library requires library.manage — same as the register
  // action that persists the row. Without this any logged-in user could mint a
  // Blob upload token straight from the API.
  if (!(await hasPermission(user, "library.manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        addRandomSuffix: true,
        maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB per file
        /*
         * An ALLOW-LIST of what the document library is actually for.
         *
         * This accepted any content type at all. That was not stored XSS — the
         * serving routes allow-list what may render inline (images and PDF, with
         * SVG deliberately excluded) and force everything else to
         * `attachment; application/octet-stream` with `nosniff` — but it did
         * leave a permissioned user able to park arbitrary binaries, at 100 MB a
         * time, on a domain customers are asked to trust.
         *
         * Listed explicitly rather than filtered by extension: the browser sends
         * the type, the Blob store enforces it here, and neither depends on a
         * filename. Covers what a dealership files — paperwork, spreadsheets,
         * scans, photos, the odd archive of them.
         */
        allowedContentTypes: [
          "application/pdf",
          "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif", "image/tiff",
          "text/plain", "text/csv",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-powerpoint",
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          "application/zip",
        ],
      }),
      onUploadCompleted: async () => {
        // DB rows are written by the register action after the browser finishes
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 400 }
    );
  }
}
