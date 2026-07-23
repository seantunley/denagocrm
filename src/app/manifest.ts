import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    // Explicit, stable app identity distinct from the Messages sub-app
    // (id "/messages"). Without an explicit id Chrome derives one from start_url,
    // which can make the two apps' identities ambiguous and cause the nested
    // /messages PWA to be treated as "already installed" by the root app.
    id: "/",
    name: "Denago CRM",
    short_name: "DenagoCRM",
    description: "Sales & EV service management for Denago Cape Town",
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
        name: "New lead",
        short_name: "New lead",
        description: "Create a sales opportunity",
        url: "/leads/new?source=pwa-shortcut",
      },
      {
        name: "New contact",
        short_name: "New contact",
        description: "Create a customer contact",
        url: "/contacts/new?source=pwa-shortcut",
      },
      {
        name: "Open pipeline",
        short_name: "Pipeline",
        description: "Open the leads pipeline",
        url: "/leads?source=pwa-shortcut",
      },
    ],
  };
}
