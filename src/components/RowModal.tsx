"use client";

import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

/** Accessible row-detail dialog. */
export default function RowModal({ row, children }: { row: ReactNode; children: ReactNode }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className="block w-full cursor-pointer px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-orange-500/40">{row}</button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-2xl border-white/10 bg-[#111412] p-5 shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-2xl sm:p-6">
        <DialogTitle className="sr-only">Details</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
