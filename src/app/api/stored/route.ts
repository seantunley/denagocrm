import { NextRequest, NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { BlobNotYoursError, isStoredFileRef, openStoredFile } from "@/lib/storage";

export const runtime = "nodejs";

/** Types a browser may render inline. Anything else downloads. SVG and HTML never render. */
const INLINE = /^(image\/(png|jpe?g|gif|webp|avif|heic|heif)|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/i;

/**
 * Serves a stored file to a signed-in staff member of the workspace that owns it.
 *
 * WHY IT EXISTS: files in the private store have no public URL, so screens that
 * used to put a stored ref straight into an <img>, <audio>, <video> or link — the
 * communications timeline, the social inbox, checklist photos — go through here
 * instead (see lib/storedFileSrc.ts).
 *
 * WHO MAY READ WHAT: the viewer must be signed in, and the file must belong to
 * the workspace they are acting in — openStoredFile makes the same ownership
 * check readFile does (the tenant namespace in the object's path). The ref only
 * reaches a page the viewer could already open, so this adds a login and a
 * workspace check to what used to be an open link. It is not a per-record
 * permission check; records with their own download route keep using it.
 */
export async function GET(request: NextRequest) {
  try {
    await requireApiUser();
  } catch (err) {
    return apiAuthErrorResponse(err) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ref = request.nextUrl.searchParams.get("ref") ?? "";
  if (!isStoredFileRef(ref)) return NextResponse.json({ error: "Not a stored file" }, { status: 400 });

  let tenantId: string;
  try {
    tenantId = await withActingStaffScope(() => actingTenantId());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { stream, contentType } = await openStoredFile(ref, tenantId);
    const inline = INLINE.test(contentType);
    return new NextResponse(stream, {
      headers: {
        "Content-Type": inline ? contentType : "application/octet-stream",
        "Content-Disposition": inline ? "inline" : "attachment",
        "X-Content-Type-Options": "nosniff",
        // Client files: never kept in a shared cache, and not on disk either.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof BlobNotYoursError) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "File unavailable" }, { status: 404 });
  }
}
