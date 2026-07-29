"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { unstable_rethrow } from "next/navigation";
import { toast } from "sonner";

import type { ActionResult } from "@/lib/actionResultTypes";
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
  success,
}: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  /**
   * Accepts converted actions. The result used to be awaited and discarded, so
   * a refusal closed the dialog silently and looked exactly like success.
   */
  onConfirm: () => void | Promise<ActionResult | void>;
  destructive?: boolean;
  /** Shown when the action succeeds without a message of its own. */
  success?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      const result = await onConfirm();
      // On refusal keep the dialog open and say why — closing it would read as
      // "done" for something that did not happen.
      if (result?.error) {
        toast.error(result.error);
        return;
      }
      if (result?.success ?? success) toast.success(result?.success ?? success);
      setOpen(false);
    } catch (error) {
      unstable_rethrow(error);
      toast.error("Something went wrong. Please try again.");
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
