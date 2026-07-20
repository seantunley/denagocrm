import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { portalCanAccessDocument } from "@/lib/portalAccess";
import { isModuleEnabled } from "@/lib/modules/enabled";
import { AUTOMOTIVE_DELIVERY_TAGS } from "@/lib/modules/registry";
import { readFile } from "@/lib/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // The customer portal is an optional module; when off, its APIs are gone too,
  // not just the pages — existing sessions and saved URLs must stop resolving.
  if (!(await isModuleEnabled("portal"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { id } = await params;
  if (!(await portalCanAccessDocument(id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const document = await prisma.document.findFirst({ where: { id, deletedAt: null } });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Automotive-owned paperwork must not resolve when the pack is off, even from a
  // saved URL. That's not just vehicle-linked docs: delivery paperwork/signatures
  // (tagged, linked via contact/quote) and job-card photos (linked via jobCardId)
  // are automotive too. Invoices, POPs and plain contact/quote docs stay downloadable.
  if (!(await isModuleEnabled("automotive"))) {
    const isAutomotiveDoc =
      document.vehicleId != null ||
      document.jobCardId != null ||
      (document.tag != null &&
        (AUTOMOTIVE_DELIVERY_TAGS as readonly string[]).includes(document.tag));
    if (isAutomotiveDoc) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }
  try {
    const bytes = await readFile(document.storedName);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.fileName)}`,
        "content-length": String(bytes.length),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ error: "File unavailable" }, { status: 404 });
  }
}
