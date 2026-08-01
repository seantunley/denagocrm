import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Denago CRM",
  description: "CRM and EV service management for Denago Cape Town",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icons/icon-192.png",
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    title: "Denago CRM",
    statusBarStyle: "black-translucent",
  },
};

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
