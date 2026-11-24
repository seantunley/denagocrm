import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { basePrisma } from "@/lib/db";
import { readManagedBlob } from "@/lib/storage";
import { brandLogoAsset } from "@/lib/tenantBrand";
import { MASKABLE_ICON_PADDING, appIconSize, appIconUrl, brandIconAsset, logoBacking, logoPadding } from "@/lib/appIcon";

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

/** A picture, whole, centred on a square with `padding` each side: its own backdrop colour, else dark or white to suit it. */
async function onSquare(bytes: Buffer, size: number, padding: number): Promise<Buffer> {
  const inner = Math.round(size * (1 - 2 * padding));
  const image = sharp(bytes, { density: 300 }).rotate();
  const { hasAlpha } = await image.metadata();
  let backing: string;
  if (hasAlpha) {
    // Average brightness of the visible pixels only.
    const { data } = await image.clone().resize(48, 48, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let weight = 0;
    let light = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      weight += a;
      light += a * ((0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255);
    }
    backing = logoBacking(weight ? light / weight : 0);
  } else {
    // An opaque logo carries its own background: continue it from the top-left pixel.
    const { data } = await image.clone().extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    backing = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }
  const drawn = await image.resize(inner, inner, { fit: "inside" }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: backing } })
    .composite([{ input: drawn, gravity: "center" }])
    .png()
    .toBuffer();
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
