import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { DEFAULT_BRAND, brandForHost } from "@/lib/tenantBrand";
import { PLATFORM_NAME } from "@/lib/platformIdentity";

// A second, separate PWA scoped to /messages — installs on a phone as its own
// "<Workspace> Messages" app icon, distinct from the main CRM, but the same login
// and data. Served as a route handler so it can live under /messages with its own
// scope. Dynamic, not static: the name is the workspace's on its own domain (it
// was "Denago Messages … for Denago Cape Town" for every workspace).
export const dynamic = "force-dynamic";

export async function GET() {
  let brand = DEFAULT_BRAND;
  try {
    brand = await brandForHost((await headers()).get("host"));
  } catch {
    // No request scope (or no host): the platform's name.
  }
  const workspace = brand.tenantId ? brand.displayName : PLATFORM_NAME;
  return NextResponse.json(
    {
      name: `${workspace} Messages`,
      short_name: "Messages",
      description: `Customer messaging & help desk for ${workspace}`,
      // Permission-aware landing (see /messages/start): routes the installed app
      // to Chats or Help desk depending on what the user can access, so a
      // cases-only help-desk user isn't bounced out on launch. Scope/id stay
      // "/messages" so this remains one installed app.
      start_url: "/messages/start",
      scope: "/messages",
      id: "/messages",
      display: "standalone",
      orientation: "portrait",
      background_color: "#020617",
      theme_color: "#020617",
      // Two maskable sizes, not one. A launcher picking by density found no
      // maskable at 192 and fell back to the "any" icon, which it then put on
      // its own plate — the white ring Sean saw around the installed icon. The
      // art is full-bleed on the background colour for the same reason: a
      // launcher masks the tile it is given, and anything it can see through
      // becomes the plate.
      icons: [
        { src: "/icons/messages-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/messages-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/messages-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
        { src: "/icons/messages-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
      shortcuts: [
        {
          name: "Open chats",
          short_name: "Chats",
          description: "Open customer conversations",
          url: "/messages?source=pwa-shortcut",
          icons: [
            {
              src: "/icons/shortcut-chats-192.png",
              sizes: "192x192",
              type: "image/png",
            },
          ],
        },
        {
          name: "Open help desk",
          short_name: "Help desk",
          description: "Open customer cases",
          url: "/messages/cases?source=pwa-shortcut",
          icons: [
            {
              src: "/icons/shortcut-helpdesk-192.png",
              sizes: "192x192",
              type: "image/png",
            },
          ],
        },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
