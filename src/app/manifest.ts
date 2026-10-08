import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { DEFAULT_BRAND, brandForHost } from "@/lib/tenantBrand";
import { PLATFORM_NAME } from "@/lib/platformIdentity";

/**
 * The installed app's name is the workspace's on its own domain. It was "Denago
 * CRM" — "Sales & EV service management for Denago Cape Town" — for everyone
 * who installed any workspace. Never throws: an unresolved host gets the
 * platform name.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  let brand = DEFAULT_BRAND;
  try {
    brand = await brandForHost((await headers()).get("host"));
  } catch {
    // No request scope (or no host): the platform's name.
  }
  const name = brand.tenantId ? brand.displayName : PLATFORM_NAME;
  return {
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
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      {
        name: "New Lead",
        short_name: "New Lead",
        description: "Create a sales opportunity",
        url: "/leads/new?source=pwa-shortcut",
        icons: [
          {
            src: "/icons/shortcut-lead-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "New Contact",
        short_name: "New Contact",
        description: "Create a customer contact",
        url: "/contacts/new?source=pwa-shortcut",
        icons: [
          {
            src: "/icons/shortcut-contact-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
      {
        name: "New Activity",
        short_name: "New Activity",
        description: "Schedule a customer or team activity",
        url: "/calendar?quick-create=activity&source=pwa-shortcut",
        icons: [
          {
            src: "/icons/shortcut-activity-192.png",
            sizes: "192x192",
            type: "image/png",
          },
        ],
      },
    ],
  };
}
