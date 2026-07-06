import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

const UPLOAD_DIR = path.join(process.cwd(), "storage", "uploads");

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
    const buffer = await fs.readFile(path.join(UPLOAD_DIR, doc.storedName));
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
    return NextResponse.json({ error: "File missing on disk" }, { status: 404 });
  }
}
