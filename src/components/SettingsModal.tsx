"use client";

import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/**
 * Shell for settings opened as an intercepted-route modal. The dialog is
 * controlled: dismissing it (close button, Escape or overlay click) unwinds the
 * intercepted URL with router.back(), so a hard refresh or shared link still
 * lands on the full settings page.
 */
export default function SettingsModal({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) router.back(); }}>
      <DialogContent
        showCloseButton
        className="flex h-[88vh] max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden p-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">{children}</div>
      </DialogContent>
    </Dialog>
  );
}
