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
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const next = value.trim();
    if (required && !next) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      setValue("");
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this value. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy && !next) return;
        setOpen(next);
        if (next) {
          setValue(defaultValue);
          setError(null);
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <ResponsiveDialogContent className="sm:max-w-md" aria-busy={busy}>
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
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !busy) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        {error && (
          <p role="alert" className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <DialogClose asChild>
            <button type="button" className="btn-secondary" disabled={busy}>Cancel</button>
          </DialogClose>
          <button type="button" className="btn-primary" disabled={busy || (required && !value.trim())} onClick={submit}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {submitLabel}
          </button>
        </div>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
