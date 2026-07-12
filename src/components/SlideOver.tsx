"use client";

import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

/** Responsive history panel: full-width on phones, restrained rail on desktop. */
export default function SlideOver({ label, title, buttonClass = "btn-secondary", children }: { label: string; title: string; buttonClass?: string; children: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild><button className={buttonClass}>{label}</button></SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 border-white/[0.08] bg-[#111412] p-0 sm:max-w-md">
        <SheetHeader className="border-b border-white/[0.07] px-5 py-4"><SheetTitle>{title}</SheetTitle></SheetHeader>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
