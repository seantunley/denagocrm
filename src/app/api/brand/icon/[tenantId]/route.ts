import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { basePrisma } from "@/lib/db";
import { readManagedBlob } from "@/lib/storage";
import { brandLogoAsset } from "@/lib/tenantBrand";
import { MASKABLE_ICON_PADDING, appIconSize, appIconUrl, brandIconAsset, logoPadding } from "@/lib/appIcon";
import { onSquare } from "@/lib/appIconDraw";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A workspace's app icon as a square PNG (lib/appIcon.ts): its own icon, else its logo centred on a square, else the
 * platform's icon. PUBLIC for the same reason as the logo route: tabs, the installed app's manifest and the sign-in
 * page ask for it before anyone signs in.
 *
 * Not a file reader: the caller names a workspace and a size, never a path. The only pictures drawn are the two the
 * workspace's own row names (brandIconRef / brandLogoRef), each path REBUILT from the tenant id and a strictly shaped
 * file name. The answer is always a freshly drawn PNG. Suspended or unknown workspaces get the platform's icon.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const size = appIconSize(req.nextUrl.searchParams.get("s"));
  const maskable = req.nextUrl.searchParams.get("m") === "1";
  const platform = () => NextResponse.redirect(new URL(appIconUrl({ tenantId: null, logoRef: null }, size, maskable), req.url), 307);

  const tenant = await basePrisma.tenant
    .findUnique({ where: { id: tenantId }, select: { active: true, brandIconRef: true, brandLogoRef: true } })
    .catch(() => null);
  if (!tenant?.active) return platform();

  try {
    const icon = brandIconAsset(tenant.brandIconRef);
    if (icon) {
      const bytes = await readManagedBlob(`branding/${tenantId}/${icon}`);
      // Full-bleed as uploaded; the maskable form keeps the art inside the launcher's safe circle (review of #1221).
      return png(maskable ? await onSquare(bytes, size, MASKABLE_ICON_PADDING) : await sharp(bytes).rotate().resize(size, size, { fit: "cover" }).png().toBuffer());
    }
    const logo = brandLogoAsset(tenant.brandLogoRef);
    if (logo) return png(await onSquare(await readManagedBlob(`branding/${tenantId}/${logo}`), size, logoPadding(maskable)));
  } catch {
    // A missing or unreadable picture: the platform's icon, never an error in someone's tab.
  }
  return platform();
}

function png(buffer: Buffer) {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      // The URL carries the icon's or logo's file name (?v=), which changes on every upload.
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
