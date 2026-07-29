"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog, DialogClose, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, ResponsiveDialogContent } from "@/components/ui/dialog";
import { SaveForm, SaveButton } from "@/components/SaveForm";
import type { ActionResult } from "@/lib/actionResultTypes";

export default function ConfirmDelete({ action, title, description, trigger = "Delete", triggerClass = "btn-danger", confirmLabel = "Delete", success = "Deleted" }: {
  /**
   * Accepts BOTH shapes deliberately. Actions converted to return `{ error }`
   * surface a real refusal message; ones still returning void keep working
   * exactly as before — so every existing call site gains pending state, a
   * confirmation toast and a self-closing dialog without being touched.
   */
  action: (formData: FormData) => Promise<ActionResult | void>;
  title: string;
  description?: string;
  trigger?: string;
  triggerClass?: string;
  confirmLabel?: string;
  /** Toast shown on success. */
  success?: string;
}) {
  // Controlled so the dialog closes once the delete actually succeeds. It used to
  // stay open with the reason still typed in, giving no sign of whether anything
  // had happened — and inviting a second click that deletes again.
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><button type="button" className={triggerClass} title={title}>{trigger}</button></DialogTrigger>
      <ResponsiveDialogContent className="border-red-500/20 bg-[#111412] sm:max-w-md">
        <DialogHeader className="text-left">
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl border border-red-400/20 bg-red-400/10 text-red-400"><AlertTriangle className="size-5" /></div>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? "This item moves to Trash and is permanently removed after 60 days."}</DialogDescription>
        </DialogHeader>
        {/* closeModalOnSuccess={false}: this component owns its OWN dialog and closes
            it via onSaved. Leaving the default on would also close an enclosing
            ModalTrigger when one is nested outside — dismissing two dialogs from a
            single confirmed delete. */}
        <SaveForm
          action={action}
          success={success}
          closeModalOnSuccess={false}
          onSaved={() => setOpen(false)}
          className="space-y-4"
        >
          <div><label className="label" htmlFor="delete-reason">Reason for deleting</label><textarea id="delete-reason" name="reason" className="input" rows={3} required placeholder="Duplicate entry or created by mistake" /></div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><DialogClose asChild><button type="button" className="btn-secondary">Cancel</button></DialogClose><SaveButton pendingLabel="Deleting…" className="btn-danger">{confirmLabel}</SaveButton></div>
        </SaveForm>
      </ResponsiveDialogContent>
    </Dialog>
  );
}
