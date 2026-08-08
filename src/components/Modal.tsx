"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

/**
 * Lets content inside the dialog close it — specifically <SaveForm>, which closes
 * on a successful save. A create form that stays open after succeeding invites a
 * duplicate submission, and for the admin/tenant creation forms it also leaves a
 * typed password sitting in a visible field.
 *
 * Defaults to a no-op so <SaveForm> works identically outside a modal.
 */
const ModalCloseContext = createContext<() => void>(() => {});

/** Close the enclosing ModalTrigger, if there is one. */
export function useCloseModal(): () => void {
  return useContext(ModalCloseContext);
}

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
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className={buttonClass}>{label}</button>
      </DialogTrigger>
      <ResponsiveDialogContent className="gap-0 border-white/20 bg-[#111412] p-0 shadow-[0_30px_100px_rgba(0,0,0,.65)] sm:max-w-2xl">
        <DialogHeader className="sticky top-0 z-10 border-b border-white/[0.07] bg-[#111412]/95 px-5 pb-4 pr-14 pt-6 text-left backdrop-blur-xl sm:px-6 sm:pr-14 sm:py-5">
          <DialogTitle className="text-xl tracking-tight">{title}</DialogTitle>
        </DialogHeader>
        <div className="p-5 sm:p-6 [&>.card]:border-0 [&>.card]:bg-transparent [&>.card]:p-0 [&>.card]:shadow-none">
          <ModalCloseContext.Provider value={() => setOpen(false)}>
            {children}
          </ModalCloseContext.Provider>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
