import { NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { readFile } from "@/lib/storage";

type UploadRow = {
  id: string;
  fileName: string;
  storedName: string;
  mimeType: string;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const rows = await basePrisma.$queryRaw<UploadRow[]>`
    SELECT "id", "fileName", "storedName", "mimeType"
    FROM "PortalUpload" WHERE "id" = ${id} LIMIT 1
  `;
  const upload = rows[0];
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const bytes = await readFile(upload.storedName);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": upload.mimeType || "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(upload.fileName)}`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File unavailable" }, { status: 404 });
  }
}
