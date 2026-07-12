import { NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { requirePortalScope } from "@/lib/portalAccess";
import { readFile } from "@/lib/storage";

type UploadRow = {
  id: string;
  contactId: string;
  fileName: string;
  storedName: string;
  mimeType: string;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const scope = await requirePortalScope().catch(() => null);
  if (!scope) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const rows = await basePrisma.$queryRaw<UploadRow[]>`
    SELECT "id", "contactId", "fileName", "storedName", "mimeType"
    FROM "PortalUpload"
    WHERE "id" = ${id} AND "contactId" = ANY(${scope.contactIds}::text[])
    LIMIT 1
  `;
  const upload = rows[0];
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const bytes = await readFile(upload.storedName);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(upload.fileName)}`,
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File unavailable" }, { status: 404 });
  }
}
