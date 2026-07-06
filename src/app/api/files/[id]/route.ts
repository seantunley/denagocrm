import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { readFile } from "@/lib/storage";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Only render safe types inline; everything else downloads as a plain
  // attachment so an uploaded HTML/SVG file can never run scripts in the CRM's origin.
  const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif)|application\/pdf)$/i;
  const inline = SAFE_INLINE.test(doc.mimeType);

  try {
    const buffer = await readFile(doc.storedName);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": inline ? doc.mimeType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(
          doc.fileName
        )}`,
        "Content-Length": String(doc.sizeBytes),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
