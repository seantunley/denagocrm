import { NextRequest, NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { readManagedBlob } from "@/lib/storage";
import { isCurrentLoginImage, parseLoginLook } from "@/lib/loginLook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

/**
 * A workspace's sign-in picture — its background photo or the picture in the card's place (lib/loginLook.ts).
 * Public, because the sign-in page is shown before anyone signs in.
 *
 * Not a file reader: only a file the workspace's CURRENT sign-in settings name is served, and its path is rebuilt from
 * the tenant id and that strictly-shaped file name — nothing from the request is joined into a path. A replaced picture
 * stops being served. No SVG is ever stored here (a document, not pixels), and the response is sandboxed regardless.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const requested = req.nextUrl.searchParams.get("a") ?? "";
  const tenant = await basePrisma.tenant.findUnique({ where: { id: tenantId }, select: { active: true, loginJson: true } }).catch(() => null);
  if (!tenant?.active) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const look = parseLoginLook(tenant.loginJson);
  if (!requested || !isCurrentLoginImage(look, requested)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const type = TYPES[requested.split(".").pop()?.toLowerCase() ?? ""];
  if (!type) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const buffer = await readManagedBlob(`branding/${tenantId}/${requested}`);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        // The file name carries a timestamp and is never overwritten, so a name always means the same bytes.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
