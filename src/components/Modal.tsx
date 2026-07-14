"use client";

import type { ReactNode } from "react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
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
      <ResponsiveDialogContent className="gap-0 border-white/20 bg-[#111412] p-0 shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-2xl">
        <DialogHeader className="sticky top-0 z-10 border-b border-white/[0.07] bg-[#111412]/95 px-5 pb-4 pt-6 text-left backdrop-blur-xl sm:px-6 sm:py-5">
          <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
        </DialogHeader>
        <div className="p-5 sm:p-6 [&>.card]:border-0 [&>.card]:bg-transparent [&>.card]:p-0 [&>.card]:shadow-none">
          {children}
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
