"use client";

import type { ReactNode } from "react";
import { Dialog, DialogTitle, DialogTrigger, ResponsiveDialogContent } from "@/components/ui/dialog";

/** Accessible row-detail dialog. `onOpen` fires once when the dialog opens —
 *  used by the inbox to mark a thread read the moment it's viewed. */
export default function RowModal({
  row,
  children,
  onOpen,
}: {
  row: ReactNode;
  children: ReactNode;
  onOpen?: () => void | Promise<void>;
}) {
  return (
    <Dialog onOpenChange={(open) => { if (open) void onOpen?.(); }}>
      <DialogTrigger asChild>
        <button type="button" className="block w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500/40">{row}</button>
      </DialogTrigger>
      <ResponsiveDialogContent className="border-white/10 bg-[#111412] shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-2xl">
        <DialogTitle className="sr-only">Details</DialogTitle>
        {children}
      </ResponsiveDialogContent>
    </Dialog>
  );
}
