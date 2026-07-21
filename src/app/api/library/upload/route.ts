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
