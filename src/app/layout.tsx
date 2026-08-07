import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { DEFAULT_BRAND, brandForHost } from "@/lib/tenantBrand";
import { PLATFORM_NAME } from "@/lib/platformIdentity";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Nonce-based CSP requires dynamic rendering everywhere.
 *
 * Next stamps the per-request nonce onto its scripts during server rendering.
 * A statically prerendered page's HTML is built once, before any request
 * exists, so its scripts carry no nonce — and `strict-dynamic` then blocks
 * them. The page renders and never hydrates.
 *
 * Without this the build prerendered /login and /platform/login, so the fix
 * would have shipped a CSP that stopped anyone signing in. Root layout rather
 * than per-page because both are "use client" files, where route segment
 * config does not apply.
 *
 * The cost is small here: every other page already reads cookies or the
 * database and was dynamic regardless.
 */
export const dynamic = "force-dynamic";

/**
 * The browser tab, per tenant.
 *
 * Was the literal "Denago CRM" — on every tenant's own domain, in every tab,
 * bookmark and home-screen shortcut. It is the single most-seen piece of
 * branding in the product and the one the brand system did not reach, because
 * metadata is resolved before any page component runs.
 *
 * `generateMetadata` can be async and read headers, and this layout already
 * forces dynamic rendering for nonce-based CSP (see below), so there is no
 * static variant that could be built with one tenant's title and served to
 * another. `brandForHost` swallows its own errors and returns DEFAULT_BRAND, so
 * the worst case is the neutral title rather than a page that fails to render —
 * metadata that throws would take the whole document with it.
 */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await brandForHost((await headers()).get("host")).catch(() => DEFAULT_BRAND);
  const title = brand.tenantId ? brand.displayName : PLATFORM_NAME;
  return {
    title,
    description: brand.tagline ?? `Customer, sales and service management for ${title}`,
    manifest: "/manifest.webmanifest",
    icons: {
      icon: "/icons/icon-192.png",
      apple: "/icons/apple-touch-icon.png",
    },
    appleWebApp: {
      capable: true,
      title,
      statusBarStyle: "black-translucent",
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#020617",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en-ZA"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
