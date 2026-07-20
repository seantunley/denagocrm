import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessDocument } from "@/lib/documentAccess";
import { portalCanAccessDocument } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { isAutomotiveOwnedDocument } from "@/lib/modules/registry";
import { readFile } from "@/lib/storage";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await getCurrentUser();
  const staffAllowed = user ? await canAccessDocument(user, id) : false;
  const portalAllowed = user ? false : await portalCanAccessDocument(id);
  if (!staffAllowed && !portalAllowed) {
    return NextResponse.json({ error: user ? "Forbidden" : "Unauthorized" }, { status: user ? 403 : 401 });
  }

  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || doc.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Record-level access passing isn't enough: when the automotive pack is off,
  // its paperwork must not resolve even from a saved URL. Mirror the portal file
  // API — 404 automotive-owned docs (vehicle/job-card linked or delivery-tagged).
  if (isAutomotiveOwnedDocument(doc) && !(await isModuleEnabled("automotive"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf)$/i;
  const inline = SAFE_INLINE.test(doc.mimeType);

  try {
    const buffer = await readFile(doc.storedName);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": inline ? doc.mimeType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
        "Content-Length": String(doc.sizeBytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
