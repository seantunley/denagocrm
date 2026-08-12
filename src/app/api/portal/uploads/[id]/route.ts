import { NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { requirePortalScope } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { readFile } from "@/lib/storage";
import { portalTenantId } from "@/lib/portalTenant";

type UploadRow = {
  id: string;
  contactId: string;
  vehicleId: string | null;
  fileName: string;
  storedName: string;
  mimeType: string;
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isModuleEnabled("portal"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const scope = await requirePortalScope().catch(() => null);
  if (!scope) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id } = await params;
  const rows = await basePrisma.$queryRaw<UploadRow[]>`
    SELECT "id", "contactId", "vehicleId", "fileName", "storedName", "mimeType"
    FROM "PortalUpload"
    WHERE "id" = ${id} AND "contactId" = ANY(${scope.contactIds}::text[])
    LIMIT 1
  `;
  const upload = rows[0];
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A vehicle-linked upload is automotive-owned; when the pack is off a saved URL
  // must stop resolving even though the row still belongs to the contact.
  if (upload.vehicleId && !(await isModuleEnabled("automotive"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    // The SAME rule the write used: uploadPortalFile namespaces the object with
    // portalTenantId(contact), so asking the contact again is symmetric by
    // construction rather than by a column two writers could drift apart on.
    //
    // Deliberately NOT `SELECT "tenantId"` from the row above. That query has no
    // tenant predicate and is a standing entry in the tenant-access ratchet;
    // merely MENTIONING the column in its SELECT list satisfies the sweep's
    // heuristic and would retire a real finding without bounding the query by
    // anything. A genuine predicate is not available either — every PortalUpload
    // row is NULL-tenant while stamping is dormant, so one would return nothing
    // and break the download outright.
    const bytes = await readFile(upload.storedName, await portalTenantId(upload.contactId));
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
