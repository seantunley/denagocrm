import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { hasAnyPermission } from "@/lib/permissions";
import { withActingStaffScope } from "@/lib/actingScope";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { readFile } from "@/lib/storage";
import { canAccessTestDriveBooking } from "@/lib/testDriveAccess";

/** Bound to the acting workspace — a route handler has nothing above it that does (see withActingStaffScope). */
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
  const asset = await prisma.testDriveAsset.findUnique({
    where: { id },
    include: { booking: { select: { id: true, deletedAt: true } } },
  });
  if (!asset || asset.booking.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await canAccessTestDriveBooking(user, asset.booking.id))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inline = /^(image\/(png|jpe?g|webp)|application\/pdf)$/i.test(asset.mimeType);
  try {
    const buffer = await readFile(asset.storedName, asset.tenantId);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": inline ? asset.mimeType : "application/octet-stream",
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
        "Content-Length": String(asset.sizeBytes),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "File missing in storage" }, { status: 404 });
  }
}
