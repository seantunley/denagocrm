"use client";

import { useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  ResponsiveDialogContent,
} from "@/components/ui/dialog";

export function TextPromptDialog({
  trigger,
  title,
  description,
  label,
  placeholder,
  defaultValue = "",
  required = true,
  submitLabel = "Save",
  onSubmit,
}: {
  trigger: ReactNode;
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  submitLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const next = value.trim();
    if (required && !next) return;
    setBusy(true);
    try {
      await onSubmit(next);
      setValue("");
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(defaultValue); }}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <label className="space-y-1.5 text-sm font-medium text-foreground">
          <span>{label}</span>
          <input
            autoFocus
            className="input"
            value={value}
            placeholder={placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submit(); } }}
          />
        </label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild><button type="button" className="btn-secondary" disabled={busy}>Cancel</button></DialogClose>
          <button type="button" className="btn-primary" disabled={busy || (required && !value.trim())} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {submitLabel}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
