"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Accessible capture-form dialog with the legacy trigger API. */
export default function ModalTrigger({
  label,
  title,
  buttonClass = "btn-primary",
  children,
}: {
  label: ReactNode;
  title: string;
  buttonClass?: string;
  children: ReactNode;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className={buttonClass}>{label}</button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto rounded-2xl border-white/10 bg-[#111412] p-0 shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-2xl">
        <DialogHeader className="sticky top-0 z-10 border-b border-white/[0.07] bg-[#111412]/95 px-6 py-5 backdrop-blur-xl">
          <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
        </DialogHeader>
        <div className="p-5 sm:p-6 [&>.card]:border-0 [&>.card]:bg-transparent [&>.card]:p-0 [&>.card]:shadow-none">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
