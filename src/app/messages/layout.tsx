import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { requireUser, getActiveTenantId } from "@/lib/auth";
import { brandForTenant, brandLogoUrl, DEFAULT_BRAND } from "@/lib/tenantBrand";
import { BrandMark } from "@/components/BrandLogo";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import MessagesNav from "@/components/MessagesNav";
import RegisterServiceWorker from "@/components/RegisterServiceWorker";
import AppContextMenu from "@/components/AppContextMenu";

export const metadata: Metadata = {
  title: "Denago Messages",
  manifest: "/messages/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Denago Messages", statusBarStyle: "black-translucent" },
  icons: { apple: "/icons/messages-apple-180.png" },
};

export const viewport: Viewport = {
  themeColor: "#020617",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  await assertPathModuleEnabled();
  // Same session-derived brand as the CRM shell. Never throws — this layout wraps
  // the whole Messages PWA.
  const brand = await getActiveTenantId()
    .then(brandForTenant)
    .catch(() => DEFAULT_BRAND);
  const logoUrl = brandLogoUrl(brand);
  const displayName = brand.displayName;
  return (
    <div className="flex h-[100svh] flex-col overflow-hidden bg-background text-foreground">
      <RegisterServiceWorker />
      {/* Same right-click menu as the CRM shell — this is the same staff, on a
          phone. It stands aside inside the reply box, where Paste is the whole
          point of right-clicking. */}
      <AppContextMenu />
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border bg-sidebar/90 px-4 backdrop-blur-xl">
        <BrandMark
          logoUrl={logoUrl}
          alt={displayName}
          className="size-7 rounded-md object-contain"
        />
        <span className="text-sm font-semibold tracking-tight">
          {brand.tenantId ? `${displayName} Messages` : "Denago Messages"}
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">{children}</main>

      <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
        <MessagesNav />
      </div>
    </div>
  );
}
