"use client";

import { usePathname, useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SettingsChromelessProvider } from "@/components/settings-workspace";

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
 */
export default function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  if (!pathname.startsWith("/settings")) return null;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) router.back(); }}>
      <DialogContent
        showCloseButton
        className="flex h-[88vh] max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden p-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 pr-14 sm:p-8 sm:pr-14">
          <SettingsChromelessProvider>{children}</SettingsChromelessProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
