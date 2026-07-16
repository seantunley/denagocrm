"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export default function ConfirmActionDialog({
  trigger,
  title,
  description,
  confirmLabel = "Continue",
  onConfirm,
  destructive = false,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  destructive?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy || next) setOpen(next); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-md" aria-busy={busy}>
        <DialogHeader className="text-left">
          <span
            className={cn(
              "mb-1 grid size-10 place-items-center rounded-xl border",
              destructive
                ? "border-red-400/20 bg-red-400/10 text-red-400"
                : "border-amber-400/20 bg-amber-400/10 text-amber-300",
            )}
          >
            <AlertTriangle className="size-5" />
          </span>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary" disabled={busy}>Cancel</button>
          </DialogClose>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={destructive ? "btn-danger" : "btn-primary"}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
