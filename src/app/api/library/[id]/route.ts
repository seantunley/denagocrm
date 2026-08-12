import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { readFile } from "@/lib/storage";

/** Downloads a specific library document version. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Match the library page/actions: viewing the library requires library.view (or
  // library.manage). The old check was "any logged-in user", so a staffer without
  // library access could still pull any library file straight from the API.
  if (!(await hasAnyPermission(user, "library.view", "library.manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const version = await prisma.libraryVersion.findUnique({ where: { id } });
  if (!version) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf)$/i;
  const inline = SAFE_INLINE.test(version.mimeType);

  try {
    // THE route the re-registration hole was about. registerLibraryDocuments takes
    // a blob URL from the client, so this is where a URL belonging to another
    // workspace would have been served back through an authorised session. #474
    // closed the write; this closes the read, so a version row that predates that
    // check — or is ever written by some future path that skips it — still cannot
    // hand over another workspace's object.
    const buffer = await readFile(version.storedName, version.tenantId);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": inline ? version.mimeType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(
          version.fileName
        )}`,
        "Content-Length": String(version.sizeBytes),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
