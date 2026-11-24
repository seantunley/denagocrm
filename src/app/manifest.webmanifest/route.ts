import { NextRequest, NextResponse } from "next/server";
import { PLATFORM_NAME } from "@/lib/platformIdentity";
import { installedAppBrand, installedAppIcons } from "@/lib/installedApp";

export const dynamic = "force-dynamic";

/**
 * The installed app: the workspace's name and icon (lib/installedApp.ts). It was "Denago CRM", then the address's
 * workspace only — so a workspace with no domain of its own installed the platform's app. A route, not manifest.ts,
 * because it reads the workspace its link names. Never throws: anything unresolved gets the platform's.
 */
export async function GET(req: NextRequest) {
  const brand = await installedAppBrand(req.nextUrl.searchParams.get("t")).catch(() => null);
  const name = brand?.tenantId ? brand.displayName : PLATFORM_NAME;
  const manifest = {
    // Explicit, stable app identity distinct from the Messages sub-app
    // (id "/messages"). Without an explicit id Chrome derives one from start_url,
    // which can make the two apps' identities ambiguous and cause the nested
    // /messages PWA to be treated as "already installed" by the root app.
    id: "/",
    name,
    short_name: name.slice(0, 12),
    description: `Customer, sales and service management for ${name}`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#020617",
    theme_color: "#020617",
    icons: installedAppIcons(brand ?? { tenantId: null, logoRef: null, displayName: name, tagline: null, primary: null, primaryForeground: null }, [
      { src: "/icons/icon-192.png", sizes: "192x192" },
      { src: "/icons/icon-512.png", sizes: "512x512" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", purpose: "maskable" },
    ]),
    shortcuts: [
      {
        name: "New Lead",
        short_name: "New Lead",
        description: "Create a sales opportunity",
        url: "/leads/new?source=pwa-shortcut",
        icons: [{ src: "/icons/shortcut-lead-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "New Contact",
        short_name: "New Contact",
        description: "Create a customer contact",
        url: "/contacts/new?source=pwa-shortcut",
        icons: [{ src: "/icons/shortcut-contact-192.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "New Activity",
        short_name: "New Activity",
        description: "Schedule a customer or team activity",
        url: "/calendar?quick-create=activity&source=pwa-shortcut",
        icons: [{ src: "/icons/shortcut-activity-192.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, max-age=300" },
  });
}
