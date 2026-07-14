"use client";

import { AlertTriangle } from "lucide-react";
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, ResponsiveDialogContent } from "@/components/ui/dialog";

export default function ConfirmDelete({ action, title, description, trigger = "Delete", triggerClass = "btn-danger", confirmLabel = "Delete" }: {
  action: (formData: FormData) => Promise<void>;
  title: string;
  description?: string;
  trigger?: string;
  triggerClass?: string;
  confirmLabel?: string;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild><button type="button" className={triggerClass} title={title}>{trigger}</button></DialogTrigger>
      <ResponsiveDialogContent className="border-red-500/20 bg-[#111412] sm:max-w-md">
        <DialogHeader className="text-left">
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-red-400/20 bg-red-400/10 text-red-400"><AlertTriangle className="size-5" /></div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? "This item moves to Trash and is permanently removed after 60 days."}</DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-4">
          <div><label className="label" htmlFor="delete-reason">Reason for deleting</label><textarea id="delete-reason" name="reason" className="input" rows={3} required placeholder="Duplicate entry or created by mistake" /></div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><DialogClose asChild><button type="button" className="btn-secondary">Cancel</button></DialogClose><button type="submit" className="btn-danger">{confirmLabel}</button></div>
        </form>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
