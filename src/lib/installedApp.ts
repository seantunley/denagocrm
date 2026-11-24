import { headers } from "next/headers";
import { DEFAULT_BRAND, brandForHost, brandForTenant, type TenantBrand } from "./tenantBrand";
import { appIconUrl } from "./appIcon";

/*
 * Whose app a phone installs. The manifest is fetched without the person's session, so the app's pages name their
 * workspace in the manifest link (?t=<tenantId>). Honoured on an address that belongs to no workspace, or to that same
 * workspace — never one workspace's name and icon on another's domain (the rule of lib/signInWorkspace.ts).
 */
export async function installedAppBrand(named: string | null): Promise<TenantBrand> {
  let host = DEFAULT_BRAND;
  try {
    host = await brandForHost((await headers()).get("host"));
  } catch {
    // No request scope: nothing to go on but the link.
  }
  if (named && /^[A-Za-z0-9_-]{1,64}$/.test(named) && (!host.tenantId || host.tenantId === named)) {
    const brand = await brandForTenant(named);
    if (brand.tenantId) return brand;
  }
  return host;
}

/** The manifest link for a page of the signed-in workspace. */
export function manifestHref(path: string, tenantId: string | null): string {
  return tenantId ? `${path}?t=${encodeURIComponent(tenantId)}` : path;
}

/** The installed app's icons: the workspace's own (lib/appIcon.ts), else the given platform set. */
export function installedAppIcons(brand: TenantBrand, platform: { src: string; sizes: string; purpose?: "maskable" }[]) {
  if (!brand.tenantId) return platform.map((icon) => ({ ...icon, type: "image/png" }));
  return [
    { src: appIconUrl(brand, 192), sizes: "192x192", type: "image/png" },
    { src: appIconUrl(brand, 512), sizes: "512x512", type: "image/png" },
    { src: appIconUrl(brand, 512, true), sizes: "512x512", type: "image/png", purpose: "maskable" as const },
  ];
}
