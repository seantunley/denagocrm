"use client";

import { useState, type ReactElement } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

export default function ConfirmActionDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  tone = "danger",
  disabled = false,
}: {
  trigger: ReactElement;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  tone?: "danger" | "primary";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const Icon = tone === "danger" ? AlertTriangle : CheckCircle2;

  async function run() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The action could not be completed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!pending) setOpen(next);
      if (!next) setError(null);
    }}>
      <DialogTrigger asChild disabled={disabled}>{trigger}</DialogTrigger>
      <ResponsiveDialogContent className="border-border bg-[#111412] sm:max-w-md">
        <DialogHeader className="text-left">
          <div className={`mb-1 flex size-10 items-center justify-center rounded-xl border ${tone === "danger" ? "border-red-400/20 bg-red-400/10 text-red-400" : "border-primary/20 bg-primary/10 text-primary"}`}>
            <Icon className="size-5" />
          </div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild><button type="button" className="btn-secondary" disabled={pending}>Cancel</button></DialogClose>
          <button type="button" className={tone === "danger" ? "btn-danger" : "btn-primary"} onClick={run} disabled={pending}>
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
