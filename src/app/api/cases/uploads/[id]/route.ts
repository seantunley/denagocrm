import { NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { getCurrentUser, getActiveTenantId } from "@/lib/auth";
import { canAccessCase, canAccessContact } from "@/lib/permissions";
import { readFile } from "@/lib/storage";
import { tenantEnforcing } from "@/lib/tenantEnforcement";

type UploadRow = {
  id: string;
  contactId: string;
  caseId: string | null;
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
    SELECT "id", "contactId", "caseId", "fileName", "storedName", "mimeType"
    FROM "PortalUpload" WHERE "id" = ${id} LIMIT 1
  `;
  const upload = rows[0];
  if (!upload) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Authorize the RECORD, not just the module. The old check only asked "is this
  // a crm/workshop/inbox staffer" — so any such user could enumerate ids and pull
  // ANY customer's case attachment (IDOR). A case upload is downloadable only by
  // staff who can view its case (mirroring requireCaseReadAccess on the case
  // page); a case-less contact upload falls back to contact access. 404 rather
  // than 403 so we don't confirm the id exists to someone who can't see it.
  const authorized = upload.caseId
    ? await canAccessCase(user, upload.caseId)
    : await canAccessContact(user, upload.contactId);
  if (!authorized) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Multi-tenancy readiness: canAccessCase/canAccessContact grant "view_all"
  // holders access regardless of tenant, so re-assert the upload's owning
  // case/contact belongs to the REQUESTER's tenant before streaming the file —
  // mirroring the contactId-in-scope check the portal-facing sibling route
  // (api/portal/uploads/[id]) already does. DORMANT while tenantEnforcing() is
  // false (today, every environment): CustomerCase/Contact rows are largely
  // NULL-tenant today (writes aren't stamped yet), so this only activates once
  // enforcement — and the tenant stamping it depends on — is actually on.
  if (tenantEnforcing()) {
    const activeTenantId = await getActiveTenantId();
    const ownerRows = upload.caseId
      ? await basePrisma.$queryRaw<Array<{ tenantId: string | null }>>`
          SELECT "tenantId" FROM "CustomerCase" WHERE "id" = ${upload.caseId} LIMIT 1
        `
      : await basePrisma.$queryRaw<Array<{ tenantId: string | null }>>`
          SELECT "tenantId" FROM "Contact" WHERE "id" = ${upload.contactId} LIMIT 1
        `;
    const ownerTenantId = ownerRows[0]?.tenantId ?? null;
    if (ownerTenantId !== activeTenantId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

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
