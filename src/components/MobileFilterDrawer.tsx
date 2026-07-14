"use client";

import type { ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export default function MobileFilterDrawer({
  children,
  title = "Filters",
  description = "Narrow the records shown on this page.",
  activeCount = 0,
}: {
  children: ReactNode;
  title?: string;
  description?: string;
  activeCount?: number;
}) {
  return (
    <div className="sm:hidden">
      <Sheet>
        <SheetTrigger asChild>
          <button type="button" className="btn-secondary w-full justify-between">
            <span className="flex items-center gap-2">
              <SlidersHorizontal className="size-4" />
              {title}
            </span>
            {activeCount > 0 && (
              <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1.5 text-[10px] font-bold leading-5 text-primary-foreground">
                {activeCount}
              </span>
            )}
          </button>
        </SheetTrigger>
        <SheetContent side="bottom" className="max-h-[88dvh] overflow-y-auto rounded-t-3xl border-border bg-background p-0">
          <SheetHeader className="border-b border-border px-5 pb-4 pt-6 text-left">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">{children}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
