import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { readFile } from "@/lib/storage";
import { canAccessTestDriveBooking } from "@/lib/testDriveAccess";
import { TEST_DRIVE_INDEMNITY } from "@/lib/signing/subject";

/**
 * The signed indemnity for one test drive, for whoever may open that test drive.
 *
 * The sealed PDF is also filed under the customer's documents, but that is a
 * different permission: a salesperson who runs test drives has to be able to
 * show the indemnity they just had signed without being given the document
 * library. So it is served here, on the booking's own rule — the same one the
 * licence scans and condition photos beside it use.
 *
 * Bound to the acting workspace — a route handler has nothing above it that does
 * (see withActingStaffScope).
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withActingStaffScope(() => handleGet(request, context));
}

async function handleGet(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!(await isModuleEnabled("automotive"))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await hasAnyPermission(user, "activities.view", "activities.manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  // One answer for "no such booking" and "not yours".
  if (!(await canAccessTestDriveBooking(user, id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const booking = await prisma.testDriveBooking.findFirst({ where: { id, deletedAt: null }, select: { tenantId: true } });
  if (!booking?.tenantId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Found THROUGH the booking, and in the booking's own workspace: the subject
  // pair carries no foreign key, so the tenant is what ties the two together.
  const signed = await prisma.signatureRequest.findFirst({
    where: {
      subjectType: TEST_DRIVE_INDEMNITY,
      subjectId: id,
      tenantId: booking.tenantId,
      status: "completed",
      signedPdfRef: { not: null },
    },
    orderBy: { completedAt: "desc" },
    select: { title: true, signedPdfRef: true, tenantId: true },
  });
  if (!signed?.signedPdfRef) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const buffer = await readFile(signed.signedPdfRef, signed.tenantId);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(`${signed.title} (signed).pdf`)}`,
        "Content-Length": String(buffer.length),
        "X-Content-Type-Options": "nosniff",
        // A signed document with the driver's details — never cached by a proxy.
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
