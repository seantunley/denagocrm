import { NextRequest, NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiOwner } from "@/lib/auth";
import { isStoredFileRef, openStoredFile } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Downloads one encrypted backup file, for an owner, from Settings → Backup &
 * recovery. That page used to link the storage URL directly, which has no
 * public form once backups are written to the private store.
 *
 * Only objects under `backups/` — this is not a general file reader. Backups
 * hold every workspace's data (AES-256-GCM encrypted), so it is owner-only,
 * exactly as the page is.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiOwner();
  } catch (err) {
    return apiAuthErrorResponse(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ref = request.nextUrl.searchParams.get("ref") ?? "";
  let pathname = "";
  try {
    pathname = new URL(ref).pathname.replace(/^\/+/, "");
  } catch {
    /* not a URL: refused below */
  }
  if (!isStoredFileRef(ref) || !pathname.startsWith("backups/") || pathname.includes("..")) {
    return NextResponse.json({ error: "Not a backup file" }, { status: 400 });
  }

  try {
    const { stream } = await openStoredFile(ref);
    const name = pathname.split("/").pop() ?? "backup.enc";
    return new NextResponse(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Backup unavailable" }, { status: 404 });
  }
}
