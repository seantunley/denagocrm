import { NextResponse } from "next/server";

// A second, separate PWA scoped to /messages — installs on a phone as its own
// "Denago Messages" app icon, distinct from the main CRM, but the same login and
// data. Served as a route handler so it can live under /messages with its own scope.
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    {
      name: "Denago Messages",
      short_name: "Messages",
      description: "Customer messaging & help desk for Denago Cape Town",
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
      icons: [
        { src: "/icons/messages-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/messages-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/messages-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
