import type { Metadata, Viewport } from "next";
import Image from "next/image";
import { requireUser } from "@/lib/auth";
import { assertPathModuleEnabled } from "@/lib/modules/routeGuard";
import MessagesNav from "@/components/MessagesNav";

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
  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border bg-sidebar/90 px-4 backdrop-blur-xl">
        <Image
          src="/branding/denago-mark.png"
          alt="Denago"
          width={28}
          height={28}
          className="size-7 rounded-md object-contain"
        />
        <span className="text-sm font-semibold tracking-tight">Denago Messages</span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">{children}</main>

      <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
        <MessagesNav />
      </div>
    </div>
  );
}
