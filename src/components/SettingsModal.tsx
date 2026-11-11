"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SettingsChromelessProvider } from "@/components/settings-workspace";

const noSubscribe = () => () => {};
const fullSettingsPageShown = () => document.querySelector("[data-settings-page]") !== null;

/**
 * Shell for settings opened as an intercepted-route modal. The dialog is
 * controlled: dismissing it (close button, Escape or overlay click) unwinds the
 * intercepted URL with router.back(), so a hard refresh or shared link still
 * lands on the full settings page.
 *
 * It also closes itself once the URL leaves /settings. On a client-side
 * navigation the @modal slot keeps rendering its last content when the new URL
 * doesn't match it, so a link inside the modal (a product in Product catalogue)
 * opened its page UNDERNEATH the still-open modal. Next's documented alternative,
 * a catch-all @modal route, matches every URL and so turned every deliberate
 * <a href="/…"> in the app into a no-html-link-for-pages lint error.
 *
 * And it never opens on top of a full Settings page (Sean, 2026-11-11): the side
 * menu on Integrations → Products stacked the catalogue as a popup over Settings,
 * and closing it stepped back through the page underneath. The section loads as
 * a full page instead — same URL, so Back still returns where you were.
 */
export default function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const overSettings = useSyncExternalStore(noSubscribe, fullSettingsPageShown, () => false);
  useEffect(() => {
    if (overSettings && pathname.startsWith("/settings")) window.location.replace(window.location.href);
  }, [overSettings, pathname]);
  if (!pathname.startsWith("/settings")) return null;
  if (overSettings) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) router.back(); }}>
      <DialogContent
        showCloseButton
        className="flex h-[88vh] max-h-[88vh] w-[96vw] max-w-[1500px] flex-col overflow-hidden p-0 sm:max-w-[1500px]"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pr-14 sm:p-8 sm:pr-14">
          <SettingsChromelessProvider>{children}</SettingsChromelessProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
