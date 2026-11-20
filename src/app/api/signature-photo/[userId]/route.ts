import { NextRequest, NextResponse } from "next/server";
import { apiAuthErrorResponse, requireApiUser } from "@/lib/auth";
import { actingTenantId } from "@/lib/actingTenant";
import { withActingStaffScope } from "@/lib/actingScope";
import { signaturePhotoBytes } from "@/lib/signatureSender";

export const runtime = "nodejs";

/**
 * A person's signature photo, for the in-app PREVIEW (the Email signatures page). Signed-in staff of the same workspace
 * only, and only a photo its owner switched on (lib/signatureSender.ts). Recipients never come here: a sent email
 * carries the photo's bytes inside it (lib/emailInlineLogo.ts), so this address is never public.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    await requireApiUser();
  } catch (error) {
    return apiAuthErrorResponse(error) ?? NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let tenantId: string;
  try {
    tenantId = await withActingStaffScope(() => actingTenantId());
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId } = await params;
  const photo = await signaturePhotoBytes(tenantId, userId).catch(() => null);
  if (!photo) return NextResponse.json({ error: "No signature photo" }, { status: 404 });
  return new NextResponse(new Uint8Array(photo.content), {
    headers: {
      "Content-Type": photo.contentType,
      "Content-Length": String(photo.content.length),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
