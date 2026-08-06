import { NextRequest, NextResponse } from "next/server";
import { basePrisma } from "@/lib/db";
import { readFile } from "@/lib/storage";
import { brandLogoAsset } from "@/lib/tenantBrand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve a tenant's brand logo. PUBLIC BY NECESSITY: its consumer is the login
 * page, which by definition renders before anyone has authenticated — the same
 * reason /login itself is in the proxy's PUBLIC_PATHS.
 *
 * What keeps a public image route from being a public file reader:
 *
 *  - The caller supplies a TENANT id, never a blob ref. The only object this
 *    route will ever stream is whatever `Tenant.brandLogoRef` points at, a
 *    column only a platform admin can write (setTenantLogoAction, which also
 *    allow-lists the content type on upload). A caller cannot steer it at any
 *    other object.
 *  - The response type is pinned to the image types the upload accepts. Even if
 *    the column somehow pointed elsewhere, the bytes go out as an image with
 *    `nosniff`, not as a document.
 *  - What it discloses is what the login page at that tenant's own hostname
 *    already displays to the world: the logo, and the fact that the tenant id
 *    exists. Suspended tenants 404 — their pages should not keep serving brand.
 *
 * Cached hard: the ref changes on every upload (timestamped path), so the URL
 * carries a `?v=` derived from the ref and the content behind a given URL never
 * changes — `immutable` is true, not optimistic.
 */

const EXT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  const { tenantId } = await params;
  const requested = req.nextUrl.searchParams.get("a");
  // basePrisma: pre-auth, no tenant scope exists, and the bypass GUC keeps this
  // working under the restricted non-BYPASSRLS role the RLS work is heading for.
  const tenant = await basePrisma.tenant.findUnique({
    where: { id: tenantId },
    select: { active: true, brandLogoRef: true },
  });
  if (!tenant?.active) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // A SPECIFIC asset when one is named, the tenant's current logo otherwise.
  //
  // This route used to serve `brandLogoRef` whatever the URL asked for, so a
  // logo frozen into a signed document silently became the replacement the day
  // one was uploaded. Resolving the requested asset is what makes a frozen brand
  // actually frozen; falling back keeps live surfaces following a rebrand, which
  // is what they should do.
  //
  // The path is REBUILT from the tenant id and a strictly matched filename, so
  // the parameter cannot walk out of this tenant's folder or name another
  // tenant's object — nothing from the request is concatenated into a path.
  let ref: string | null = null;
  if (requested) {
    const asset = brandLogoAsset(requested);
    if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
    ref = `branding/${tenantId}/${asset}`;
  } else {
    ref = tenant.brandLogoRef;
  }
  if (!ref) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ext = ref.split(".").pop()?.toLowerCase() ?? "";
  const contentType = EXT_TYPES[ext];
  if (!contentType) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const buffer = await readFile(ref);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        // An SVG is a document, not just pixels: it can carry script, and this
        // route serves it from the application's OWN origin, so anything it ran
        // would run as the CRM. Neutralised for every type rather than only SVG,
        // because an image response has no legitimate need for any of it.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // A dangling ref (blob deleted out-of-band) is a missing logo, not an error
    // page — the login page falls back to its default mark either way.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
