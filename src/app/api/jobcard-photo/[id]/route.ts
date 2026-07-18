import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessJobCard } from "@/lib/permissions";
import { readFile } from "@/lib/storage";

/**
 * Serves a job-card check-in / check-out photo, same-origin and gated on job-card
 * read access (not the documents.* scope — technicians who can see a job card can see
 * and mark up its condition photos). Same-origin delivery also lets the annotation
 * editor draw the base image onto a canvas and export it without cross-origin taint.
 *
 * ?v=annotated returns the flattened marked-up version when one exists, else the original.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc || doc.deletedAt || !doc.jobCardId || (doc.tag !== "checkin-photo" && doc.tag !== "checkout-photo")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!(await canAccessJobCard(user, doc.jobCardId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const annotated = new URL(req.url).searchParams.get("v") === "annotated";
  const ref = annotated && doc.annotatedStoredName ? doc.annotatedStoredName : doc.storedName;
  // The flattened markup is stored as JPEG (older ones may be PNG); the original
  // keeps its own mime type. Derive the annotated type from the stored extension.
  const annotatedMime = /\.png(?:$|\?)/i.test(ref) ? "image/png" : "image/jpeg";
  const mimeType = annotated && doc.annotatedStoredName ? annotatedMime : doc.mimeType;

  const SAFE_INLINE = /^image\/(png|jpe?g|gif|webp|avif)$/i;
  if (!SAFE_INLINE.test(mimeType)) {
    return NextResponse.json({ error: "Unsupported media" }, { status: 415 });
  }

  try {
    const buffer = await readFile(ref);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
